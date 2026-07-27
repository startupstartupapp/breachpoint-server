/**
 * LOBBY — many matches in one process, keyed by a join code.
 *
 * WHY THIS EXISTS
 *
 *   A browser cannot host a game server, so "create a game" cannot mean "spawn
 *   a process". It means: ask a dedicated server that is already running to open
 *   a NEW match and hand back a code you can give to a friend. That is all this
 *   file is — a `Map<code, Room>` with a door policy.
 *
 * WHY THE ROUTE IS THE CONNECT URL
 *
 *   `attachWebSocket` already hands the upgrade request to its callback, so the
 *   room is chosen from `ws://host/?room=ABCD` before a single game message is
 *   parsed. No new message type, no lobby protocol, no state machine: a
 *   connection belongs to exactly one room for its whole life, decided once.
 *
 * WHAT IS UNTRUSTED
 *
 *   Everything in that URL. A code is uppercased, length-and-charset checked and
 *   looked up BEFORE it is ever used as a Map key; an unknown code is a clean
 *   close, never an implicit create (otherwise a typo silently strands a player
 *   alone in a room nobody else will ever find). Names are stripped of control
 *   characters, the mode must be one we actually have, the player cap is
 *   clamped, and the whole query string is rejected past MAX_URL bytes.
 *
 *   THE ROOM MAP IS BOUNDED. MAX_ROOMS concurrent matches, and a created room
 *   with nobody in it is reaped. Without both, "create a game" is a memory DoS
 *   with a friendly button.
 */

import { randomInt } from 'node:crypto';

import { Room, MAX_PLAYERS, MODES } from './room.js';

/**
 * No 0/O/1/I/L: a join code gets read aloud, screenshotted and retyped, and
 * every one of those is a pair somebody will confuse. 31^4 ≈ 924k codes.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LEN = 4;

/** Concurrent matches per process. Each one is a 30 Hz tick and 12 slots. */
export const MAX_ROOMS = 8;
/** A created room with nobody in it for this long is disposed. */
const EMPTY_TTL_MS = 60_000;
/** Longest connect URL we will even look at. */
const MAX_URL = 512;
const MAX_NAME = 24;

/** True only for a string that could be a code. Never trust it beyond this. */
export function isCode(s) {
  if (typeof s !== 'string' || s.length !== CODE_LEN) return false;
  for (let i = 0; i < s.length; i++) if (!CODE_ALPHABET.includes(s[i])) return false;
  return true;
}

/** Uppercase and strip separators people paste in ("ab-cd", " abcd "). */
export function normaliseCode(s) {
  return typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN) : '';
}

/** Match names are listed to strangers: printable, trimmed, bounded. */
function cleanLabel(v, dflt) {
  if (typeof v !== 'string') return dflt;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
  return s.length ? s : dflt;
}

export class Lobby {
  /**
   * @param seed   base seed; each room forks a distinct one so two matches do
   *               not share a spawn sequence.
   * @param onChange called whenever the room set changes, so the registry can
   *               publish promptly instead of waiting for the next heartbeat.
   */
  constructor({ seed = 0x5eed1234, log = () => {}, onChange = () => {} } = {}) {
    this.log = log;
    this.seed = seed >>> 0;
    this.onChange = onChange;
    /** code -> Room. The default public match lives under the empty string. */
    this.rooms = new Map();
    this._seq = 0;

    // The default room is exactly the single room this server used to be: no
    // code, public, always present, never reaped. An old client that connects
    // to `ws://host:port` with no query string lands here and cannot tell the
    // difference.
    this.default = new Room({ seed: this.seed, log, name: 'Public Match' });
    this.rooms.set('', this.default);
    this.default.start();

    this._reaper = setInterval(() => this.reap(), 15_000);
    this._reaper.unref?.();
  }

  get(code) {
    return this.rooms.get(code) ?? null;
  }

  /** Total players across every match — what the host reports as its load. */
  get count() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.count;
    return n;
  }

  /**
   * Open a new match. Returns the room, or null when the process is at its cap
   * — the caller must treat that as a refusal, not retry into it.
   */
  create({ name, mode, maxPlayers, isPrivate } = {}) {
    if (this.rooms.size >= MAX_ROOMS) return null;
    const code = this._mintCode();
    if (!code) return null;

    const room = new Room({
      // Distinct per room: two matches created a millisecond apart must not
      // share a spawn sequence just because they share a process.
      seed: (this.seed ^ Math.imul(++this._seq, 0x9e3779b9)) >>> 0,
      log: (msg) => this.log(`[${code}] ${msg}`),
      maxPlayers: clampInt(maxPlayers, 2, MAX_PLAYERS, MAX_PLAYERS),
      code,
      name: cleanLabel(name, `Match ${code}`),
      mode: MODES[mode] ? mode : 'TDM',
      isPrivate: !!isPrivate,
    });
    room.createdAt = Date.now();
    room.emptyAt = Date.now();
    this.rooms.set(code, room);
    room.start();
    this.log(`create room=${code} name="${room.name}" mode=${room.mode} ` +
             `max=${room.maxPlayers} private=${room.private} (${this.rooms.size} rooms)`);
    this.onChange();
    return room;
  }

  /** A code no live room is using. Null if we are somehow saturated. */
  _mintCode() {
    for (let attempt = 0; attempt < 64; attempt++) {
      let code = '';
      // Deliberately NOT the room RNG: that one is seeded and replayable, which
      // is exactly right for spawn selection and exactly wrong for a code — two
      // servers started with the same --seed would mint the same codes, and a
      // guessable code is a stranger walking into a private match.
      for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  /**
   * Decide which match a fresh connection belongs to and attach it.
   *
   * Every refusal closes with a distinct code so the client can say something
   * true: 1008 is "that code is wrong", 1013 is "this server is full".
   */
  route(conn, req) {
    const url = typeof req?.url === 'string' ? req.url : '/';
    if (url.length > MAX_URL) {
      conn.close(1009, 'url too long');
      return null;
    }

    let params;
    try {
      params = new URLSearchParams(url.slice(url.indexOf('?') + 1 || url.length));
    } catch {
      conn.close(1008, 'bad request');
      return null;
    }

    const raw = params.get('room');
    if (raw) {
      const code = normaliseCode(raw);
      // Validate the SHAPE before the lookup, so a hostile string never even
      // becomes a Map key, and an unknown-but-valid code is a clean refusal.
      if (!isCode(code)) {
        conn.close(1008, 'bad code');
        return null;
      }
      const room = this.rooms.get(code);
      if (!room) {
        conn.close(1008, 'no such room');
        return null;
      }
      room.attach(conn);
      return room;
    }

    if (params.get('create') === '1') {
      const room = this.create({
        name: params.get('name'),
        mode: params.get('mode'),
        maxPlayers: params.get('max'),
        isPrivate: params.get('private') === '1',
      });
      if (!room) {
        conn.close(1013, 'server at capacity');
        return null;
      }
      room.attach(conn);
      return room;
    }

    this.default.attach(conn);
    return this.default;
  }

  /**
   * Dispose created rooms that nobody is in and nobody has joined for a while.
   * The default room is permanent — it is the address printed in the README.
   */
  reap() {
    const now = Date.now();
    let changed = false;
    for (const [code, room] of this.rooms) {
      if (!code) continue;
      if (room.count > 0 || room.sessions.size > 0) {
        room.emptyAt = now;
        continue;
      }
      if (now - (room.emptyAt ?? now) < EMPTY_TTL_MS) continue;
      room.dispose();
      this.rooms.delete(code);
      changed = true;
      this.log(`reap   room=${code} (${this.rooms.size} rooms)`);
    }
    if (changed) this.onChange();
  }

  /** One plain row per match — what the registry publishes and /health shows. */
  rows() {
    const out = [];
    for (const room of this.rooms.values()) {
      out.push({
        code: room.code,
        name: room.name,
        mode: room.mode,
        private: room.private,
        players: room.count,
        maxPlayers: room.maxPlayers,
        state: room.state === 'over' ? 'ended' : room.state === 'live' ? 'live' : 'warmup',
      });
    }
    return out;
  }

  dispose() {
    clearInterval(this._reaper);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return n < min ? min : n > max ? max : n;
}
