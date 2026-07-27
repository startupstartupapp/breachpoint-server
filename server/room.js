/**
 * ROOM — one match. The fixed tick, the authoritative simulation, the round
 * state machine and the only scoreboard anybody is allowed to believe.
 *
 * WHY IT LOOKS LIKE THIS
 *
 *   THE CLIENT SENDS INTENT, NEVER STATE. A `cmd` is two move axes, two look
 *   angles and a button bitmask. The server integrates the position itself, with
 *   its OWN dt, and clamps the resulting speed. There is no message a client can
 *   send that sets its position, its health or its score.
 *
 *   ONE COMMAND PER TICK. A client that floods 500 cmds a second must not move
 *   500 times faster than one sending 30. Every tick each player consumes the
 *   whole queue but integrates exactly ONE step of TICK_DT: the newest axes and
 *   angles win, and the button bits of every dropped command are OR-ed in so a
 *   jump tapped between ticks is not silently eaten. Speed hacking by send rate
 *   is structurally impossible, not merely detected.
 *
 *   THE TICK DOES NOT DRIFT. Same accumulator as `src/core/engine.js`: real
 *   elapsed time in, fixed dt steps out, MAX_SUBSTEPS then shed the backlog
 *   rather than spiral.
 *
 *   SAME VOCABULARY AS src/match. Phases are `warmup | live | roundend |
 *   intermission | over`. An entry carries kills/deaths/assists/kd/score/streak.
 *   A kill is 100, a headshot another 50, an assist 50, and assists come off the
 *   same fixed 8-slot damage ring. If the client and the server ever disagree
 *   about what a scoreboard says, it is not because they used different words.
 *
 *   DETERMINISTIC. No `Math.random()` anywhere. Spawn selection runs off the
 *   seeded xoshiro128** below (the same generator as `src/core/rng.js`, which
 *   server/ may not import), so a replayed sequence of inputs replays exactly.
 *
 *   NOTHING ALLOCATES PER TICK. Snapshot payload objects, the standings array,
 *   the damage rings and the history ring are all built once in the constructor
 *   and mutated in place forever.
 */

import { HitRegistry, HISTORY_TICKS } from './hitreg.js';

export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
/** Never simulate more than this many ticks in one wake-up. */
const MAX_SUBSTEPS = 5;
export const MAX_PLAYERS = 12;

/** Mirrors `UNITS` in src/core/config.js. */
const UNITS = {
  gravity: -9.81 * 2.1,
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12,
};

/** Mirrors STANCE/MOVE in src/player/tuning.js — the numbers the client feels. */
const MOVE = {
  standSpeed: 4.57,
  crouchSpeed: 2.44,
  sprintSpeed: 7.01,
  adsScale: 0.5,
  strafeScale: 0.92,
  backScale: 0.8,
  groundAccel: 92,
  groundDecel: 52,
  airAccelScale: 0.25,
  terminalSpeed: 55,
  jumpApex: 0.6,
  jumpCooldown: 0.28,
  /** Hard ceiling on horizontal speed after integration. Belt and braces. */
  speedCeiling: 7.01 * 1.25,
};
const JUMP_SPEED = Math.sqrt(2 * Math.abs(UNITS.gravity) * MOVE.jumpApex);

/** Mirrors `MATCH` in src/core/config.js. */
export const MATCH = {
  mode: 'TDM',
  scoreLimit: 25,
  timeLimit: 300,
  rounds: 3,
  warmup: 6,
  roundEnd: 5,
  intermission: 8,
  /** Seconds on the final scoreboard before the room starts a fresh match. */
  postMatch: 20,
  respawnDelay: 3.5,
  assistWindow: 8,
  assistFraction: 0.2,
};

/**
 * Playlists, mirroring `MODES` in src/core/config.js. A mode is a *label plus
 * three limits* — the server scores every one of them as team deathmatch,
 * because that is all any of them are on the client too. Anything a player can
 * pick when creating a match has to exist here or it is not a real choice.
 */
export const MODES = {
  TDM: { label: 'Team Deathmatch', scoreLimit: 25, timeLimit: 300, rounds: 3 },
  SKIRMISH: { label: 'Skirmish', scoreLimit: 15, timeLimit: 180, rounds: 1 },
  ATTRITION: { label: 'Attrition', scoreLimit: 50, timeLimit: 600, rounds: 1 },
};

const BTN = { fire: 1, ads: 2, jump: 4, crouch: 8, sprint: 16, reload: 32 };
const ST = { crouch: 1, sprint: 2, ads: 4, airborne: 8 };

const LOG_SLOTS = 8;
const KILL_WINDOW = 6;
const MAX_HP = 100;
/** Commands buffered per player between ticks. Beyond this the client is spamming. */
const CMD_QUEUE_CAP = 16;
/** Messages a connection may send per second before it is dropped. */
const MSG_RATE_CAP = 240;
/** Fastest legal trigger pull, seconds. ~1200 RPM. */
const FIRE_MIN_INTERVAL = 0.05;
/** Half-extent of the playable box, metres. */
const ARENA = 60;
/** Broadcast the full match/scoreboard message at least this often, ticks. */
const MATCH_HEARTBEAT = 30;
/** App-level RTT probe interval, ticks. */
const PING_INTERVAL = 30;
/** No command for this many ticks and the held input is released. */
const STALE_INPUT_TICKS = 15;

/* ====================================================================== */
/* deterministic rng — xoshiro128**, same construction as src/core/rng.js  */
/* ====================================================================== */

export class Rng {
  constructor(seed = 0x9e3779b9) {
    let z = seed >>> 0;
    const next = () => {
      z = (z + 0x9e3779b9) >>> 0;
      let x = z;
      x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
      x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
      return (x ^ (x >>> 15)) >>> 0;
    };
    this.s0 = next(); this.s1 = next(); this.s2 = next(); this.s3 = next();
  }

  u32() {
    const rot = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = Math.imul(rot(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rot(this.s3, 11);
    return result;
  }

  float() { return this.u32() / 4294967296; }
  range(min, max) { return min + (max - min) * this.float(); }
}

/* ====================================================================== */
/* untrusted-input helpers                                                */
/* ====================================================================== */

/** Every number off the wire goes through this. NaN/Infinity/strings -> dflt. */
function num(v, min, max, dflt = 0) {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return dflt;
  return n < min ? min : n > max ? max : n;
}

function int(v, min, max, dflt = 0) {
  return Math.round(num(v, min, max, dflt));
}

/** Names are shown to other players, so strip anything that is not printable. */
function cleanName(v, dflt) {
  if (typeof v !== 'string') return dflt;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16);
  return s.length ? s : dflt;
}

/** Snapshot floats: 1 mm is far below what anybody can see, and it halves JSON. */
function r3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

/* ====================================================================== */

export class Room {
  /**
   * `code`/`name`/`mode`/`isPrivate` are the *identity* of a player-created
   * match; they never reach the simulation, only the registry and the lobby
   * listing. A room with an empty code is the process's default public match,
   * which is exactly what this class was before codes existed.
   */
  constructor({
    seed = 0x5eed1234, log = () => {}, maxPlayers = MAX_PLAYERS,
    code = '', name = '', mode = 'TDM', isPrivate = false,
  } = {}) {
    this.log = log;
    this.maxPlayers = maxPlayers;
    this.rng = new Rng(seed);

    this.code = code;
    this.name = name || 'Public Match';
    this.mode = MODES[mode] ? mode : 'TDM';
    this.private = !!isPrivate;
    /** Phase durations and score limit for THIS room's playlist. */
    this.limits = { ...MATCH, ...MODES[this.mode] };

    this.tick = 0;
    /** Seconds of simulated time. Never wall-clock; the sim owns its own clock. */
    this.now = 0;
    this.state = 'warmup';
    this.round = 1;
    this.timeLeft = this.limits.warmup;
    this.teams = [
      { id: 0, name: 'ALLIES', score: 0 },
      { id: 1, name: 'OPFOR', score: 0 },
    ];
    this.wins = [0, 0];

    /** Fixed slot table. `players[i]` is null or the entry holding slot i. */
    this.players = new Array(maxPlayers).fill(null);
    /** Every attached connection, joined or not. */
    this.sessions = new Set();

    this.hitreg = new HitRegistry({ maxPlayers, tickRate: TICK_RATE });

    /* ---- spawn points: a deterministic ring, two halves, one per team ---- */
    this.spawns = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + this.rng.range(-0.06, 0.06);
      const rad = 22 + this.rng.range(-3, 3);
      this.spawns.push({
        x: Math.cos(a) * rad,
        y: 0,
        z: Math.sin(a) * rad,
        yaw: Math.atan2(-Math.cos(a), -Math.sin(a)),
        team: i < 6 ? 0 : 1,
      });
    }

    /* ---- preallocated payloads (mutated in place, stringified per tick) ---- */
    this._snapPlayers = [];
    for (let i = 0; i < maxPlayers; i++) {
      this._snapPlayers.push({ id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 0, alive: false, team: 0, st: 0 });
    }
    this._snapLive = [];
    this._snap = { t: 'snap', tick: 0, ack: 0, players: this._snapLive };
    this._matchMsg = {
      t: 'match', phase: 'warmup', round: 1, timeLeft: 0,
      teams: [{ id: 0, score: 0 }, { id: 1, score: 0 }],
      standings: [],
    };
    this._standRows = [];
    for (let i = 0; i < maxPlayers; i++) {
      this._standRows.push({ id: 0, name: '', team: 0, kills: 0, deaths: 0, assists: 0, kd: 0, score: 0, streak: 0 });
    }
    this._hitMsg = { t: 'hit', by: 0, on: 0, amount: 0, headshot: false, killed: false };
    this._killMsg = { t: 'kill', by: 0, on: 0, headshot: false };

    this._matchDirty = true;
    this._sinceMatch = 0;
    this._accum = 0;
    this._last = 0;
    this._timer = null;
  }

  /* ================================================================== */
  /* connections                                                        */
  /* ================================================================== */

  /** Take ownership of a fresh WebSocket. The player slot appears on `hello`. */
  attach(conn) {
    const sess = { conn, player: null, msgCount: 0, msgWindow: 0, pingId: 0, pingAt: 0, rttMs: 0 };
    this.sessions.add(sess);
    conn.on('message', (raw) => this._onMessage(sess, raw));
    conn.on('close', () => this._detach(sess));
    conn.on('error', () => {}); // 'close' always follows; nothing to do here
    return sess;
  }

  _detach(sess) {
    if (!this.sessions.delete(sess)) return;
    const p = sess.player;
    if (!p) return;
    this.players[p.id] = null;
    sess.player = null;
    this.log(`leave  id=${p.id} name=${p.name} team=${p.team} (${this.count} online)`);
    this._matchDirty = true;
  }

  get count() {
    let n = 0;
    for (let i = 0; i < this.players.length; i++) if (this.players[i]) n++;
    return n;
  }

  /* ================================================================== */
  /* messages — every branch treats its payload as hostile              */
  /* ================================================================== */

  _onMessage(sess, raw) {
    if (sess.conn.closed) return;

    // Rate limit before parsing: a flood of garbage must cost us nothing.
    if (this.now - sess.msgWindow >= 1) {
      sess.msgWindow = this.now;
      sess.msgCount = 0;
    }
    if (++sess.msgCount > MSG_RATE_CAP) {
      sess.conn.close(1008, 'message flood');
      return;
    }

    if (typeof raw !== 'string' || raw.length > 4096) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return; // malformed JSON is simply ignored; it never reaches the sim
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'hello': return this._onHello(sess, m);
      case 'cmd': return this._onCmd(sess, m);
      case 'fire': return this._onFire(sess, m);
      case 'pong': return this._onPong(sess, m);
      default: return; // unknown type: ignored, not an error
    }
  }

  _onHello(sess, m) {
    if (sess.player) return; // one join per connection
    const id = this.players.indexOf(null);
    if (id < 0) {
      sess.conn.close(1013, 'room full');
      return;
    }

    let a = 0, b = 0;
    for (const p of this.players) if (p) (p.team === 0 ? a++ : b++);
    const team = a <= b ? 0 : 1;

    const p = this._makePlayer(id, cleanName(m.name, `PLAYER-${id + 1}`), team, sess);
    this.players[id] = p;
    sess.player = p;
    sess.session = typeof m.session === 'string' ? m.session.slice(0, 64) : '';

    this._respawn(p);
    this.log(`join   id=${id} name=${p.name} team=${team} (${this.count} online)`);

    sess.conn.send(JSON.stringify({
      t: 'welcome',
      id,
      tick: this.tick,
      tickRate: TICK_RATE,
      you: this._publicOf(p, this._snapPlayers[id]),
      // Which match this actually is. A client that asked the server to CREATE a
      // room learns its join code here and nowhere else — the code is minted
      // server-side, so this is the only moment the client can first see it.
      room: {
        code: this.code, name: this.name, mode: this.mode,
        private: this.private, maxPlayers: this.maxPlayers,
      },
    }));
    this._matchDirty = true;
  }

  _onCmd(sess, m) {
    const p = sess.player;
    if (!p) return;
    const seq = int(m.seq, 0, 0x7fffffff, 0);
    // Replays and reorders are dropped: a command older than one we have already
    // acked is either lag or an attempt to re-run a favourable input.
    if (seq <= p.lastSeq) return;
    if (p.queue.length >= CMD_QUEUE_CAP) p.queue.shift();
    p.lastSeq = seq;
    p.queue.push({
      seq,
      moveX: num(m.moveX, -1, 1, 0),
      moveY: num(m.moveY, -1, 1, 0),
      yaw: num(m.yaw, -1e4, 1e4, p.yaw),
      pitch: num(m.pitch, -1.5533, 1.5533, p.pitch), // +-88 degrees
      buttons: int(m.buttons, 0, 63, 0) | 0,
    });
  }

  _onFire(sess, m) {
    const p = sess.player;
    if (!p || !p.alive) return;
    if (this.state !== 'live' && this.state !== 'warmup') return;
    if (this.now - p.lastFireAt < FIRE_MIN_INTERVAL) return; // rate-of-fire cap
    const o = m.origin, d = m.dir;
    if (!Array.isArray(o) || o.length !== 3 || !Array.isArray(d) || d.length !== 3) return;
    p.lastFireAt = this.now;

    const res = this.hitreg.resolve(
      p, this.players,
      num(o[0], -1e4, 1e4, NaN), num(o[1], -1e4, 1e4, NaN), num(o[2], -1e4, 1e4, NaN),
      num(d[0], -1e4, 1e4, NaN), num(d[1], -1e4, 1e4, NaN), num(d[2], -1e4, 1e4, NaN),
      this.tick, sess.rttMs
    );
    if (!res.ok) return;

    const victim = this.players[res.victimId];
    if (!victim) return;

    this._logDamage(victim, p.id, res.damage, res.headshot);

    const h = this._hitMsg;
    h.by = p.id; h.on = victim.id; h.amount = res.damage;
    h.headshot = res.headshot; h.killed = res.killed;
    this._broadcast(JSON.stringify(h));

    if (res.killed) this._death(victim);
  }

  _onPong(sess, m) {
    const id = int(m.id, 0, 0x7fffffff, -1);
    if (id !== sess.pingId || !sess.pingAt) return;
    const rtt = (this.now - sess.pingAt) * 1000;
    sess.pingAt = 0;
    if (!Number.isFinite(rtt) || rtt < 0) return;
    // Smoothed: one bad sample must not swing the lag-comp rewind.
    sess.rttMs = sess.rttMs ? sess.rttMs * 0.7 + Math.min(rtt, 1000) * 0.3 : Math.min(rtt, 1000);
  }

  /* ================================================================== */
  /* players                                                            */
  /* ================================================================== */

  _makePlayer(id, name, team, sess) {
    const p = {
      id, name, team, sess,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      yaw: 0, pitch: 0,
      hp: MAX_HP,
      alive: true,
      grounded: true,
      crouch: false, sprint: false, ads: false,
      height: UNITS.playerHeight,
      eyeHeight: UNITS.playerHeight - UNITS.eyeOffset,
      /* --- input --- */
      queue: [],
      lastSeq: 0,
      ackSeq: 0,
      lastCmdTick: 0,
      moveX: 0, moveY: 0, buttons: 0,
      lastFireAt: -1e9,
      jumpAt: -1e9,
      /* --- scoreboard, same fields as a src/match entry --- */
      kills: 0, deaths: 0, assists: 0, kd: 0, score: 0, streak: 0, bestStreak: 0,
      respawnAt: -1,
      log: [],
      logAt: 0,
    };
    for (let i = 0; i < LOG_SLOTS; i++) {
      p.log.push({ attackerId: -1, amount: 0, at: -1e9, headshot: false });
    }
    return p;
  }

  /** Farthest spawn from the nearest live enemy, preferring this team's half. */
  _pickSpawn(p) {
    let best = this.spawns[0];
    let bestScore = -Infinity;
    for (let i = 0; i < this.spawns.length; i++) {
      const sp = this.spawns[i];
      let nearest = Infinity;
      for (let k = 0; k < this.players.length; k++) {
        const foe = this.players[k];
        if (!foe || foe === p || foe.team === p.team || !foe.alive) continue;
        const dx = foe.x - sp.x, dz = foe.z - sp.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < nearest) nearest = d;
      }
      // Own-half is a rank, not a distance — a friendly spawn beats every
      // enemy-half point however empty that one is.
      const score = Math.min(nearest, 60) + (sp.team === p.team ? 100 : 0) + this.rng.range(0, 2);
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    return best;
  }

  _respawn(p) {
    const sp = this._pickSpawn(p);
    p.x = sp.x; p.y = sp.y; p.z = sp.z;
    p.vx = p.vy = p.vz = 0;
    p.yaw = sp.yaw; p.pitch = 0;
    p.hp = MAX_HP;
    p.alive = true;
    p.grounded = true;
    p.crouch = p.sprint = p.ads = false;
    p.height = UNITS.playerHeight;
    p.eyeHeight = UNITS.playerHeight - UNITS.eyeOffset;
    p.respawnAt = -1;
    p.queue.length = 0;
  }

  /* ================================================================== */
  /* authoritative movement                                             */
  /* ================================================================== */

  /**
   * Consume this player's command queue and advance them ONE fixed step.
   *
   * Whatever the client claims about where it is, this is where it is. The only
   * things read out of a command are two axes in [-1,1], two clamped angles and
   * six button bits.
   */
  _integrate(p, dt) {
    if (p.queue.length) {
      let buttons = 0;
      let last = null;
      for (let i = 0; i < p.queue.length; i++) {
        buttons |= p.queue[i].buttons;
        last = p.queue[i];
      }
      p.queue.length = 0;
      p.moveX = last.moveX;
      p.moveY = last.moveY;
      p.yaw = last.yaw;
      p.pitch = last.pitch;
      p.buttons = buttons;
      p.ackSeq = last.seq;
      p.lastCmdTick = this.tick;
    } else if (this.tick - p.lastCmdTick > STALE_INPUT_TICKS) {
      // Input goes stale rather than sticking. A client that stops sending —
      // lag spike, closed laptop, or a deliberate "let go of the keyboard while
      // still sprinting" — comes to a stop instead of running on forever.
      p.moveX = 0;
      p.moveY = 0;
      p.buttons &= BTN.crouch;
    }

    if (!p.alive) {
      p.vx = p.vy = p.vz = 0;
      return;
    }

    const b = p.buttons;
    p.crouch = (b & BTN.crouch) !== 0;
    p.ads = (b & BTN.ads) !== 0;
    p.height = p.crouch ? UNITS.playerCrouchHeight : UNITS.playerHeight;
    p.eyeHeight = p.crouch ? UNITS.playerCrouchHeight - 0.1 : UNITS.playerHeight - UNITS.eyeOffset;

    // Move axes normalised so diagonal is not a free 41 % speed bonus.
    let mx = p.moveX, my = p.moveY;
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }

    p.sprint = (b & BTN.sprint) !== 0 && !p.crouch && !p.ads && my > 0.5 && mag > 0.1;

    let speed = p.crouch ? MOVE.crouchSpeed : p.sprint ? MOVE.sprintSpeed : MOVE.standSpeed;
    if (p.ads) speed *= MOVE.adsScale;
    if (my < 0) speed *= MOVE.backScale;
    else if (Math.abs(mx) > Math.abs(my)) speed *= MOVE.strafeScale;

    // three.js convention: yaw 0 looks down -Z. right = forward x up.
    const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
    const wishX = (-s) * my + c * mx;
    const wishZ = (-c) * my + (-s) * mx;

    const targetX = wishX * speed;
    const targetZ = wishZ * speed;
    const accel = (p.grounded ? MOVE.groundAccel : MOVE.groundAccel * MOVE.airAccelScale) * dt;
    const decel = (p.grounded ? MOVE.groundDecel : 0) * dt;

    if (mag > 0.01) {
      const dx = targetX - p.vx, dz = targetZ - p.vz;
      const dl = Math.hypot(dx, dz);
      if (dl > 1e-6) {
        const step = Math.min(dl, accel);
        p.vx += (dx / dl) * step;
        p.vz += (dz / dl) * step;
      }
    } else if (p.grounded) {
      const sp = Math.hypot(p.vx, p.vz);
      if (sp > 1e-6) {
        const k = Math.max(0, sp - decel) / sp;
        p.vx *= k;
        p.vz *= k;
      }
    }

    if ((b & BTN.jump) && p.grounded && this.now - p.jumpAt > MOVE.jumpCooldown) {
      p.vy = JUMP_SPEED;
      p.grounded = false;
      p.jumpAt = this.now;
    }

    if (!p.grounded) {
      p.vy += UNITS.gravity * dt;
      if (p.vy < -MOVE.terminalSpeed) p.vy = -MOVE.terminalSpeed;
    }

    // The final gate: however the numbers above were reached, nobody exceeds
    // this. Any future movement mode has to fit under the ceiling or raise it
    // here, in the one place the ceiling lives.
    const hs = Math.hypot(p.vx, p.vz);
    if (hs > MOVE.speedCeiling) {
      const k = MOVE.speedCeiling / hs;
      p.vx *= k;
      p.vz *= k;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    // ponytail: flat ground at y=0 plus a box bound, because server/ has no
    // level collision — the static BVH lives in src/world and cannot be
    // imported. Ceiling: no stairs, no walls, players slide over the map floor.
    // Upgrade path is a serialised collision mesh exported by `world` and swept
    // here with the same capsule solver src/physics/character.js uses.
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
    } else {
      p.grounded = false;
    }
    if (p.x < -ARENA) { p.x = -ARENA; p.vx = 0; } else if (p.x > ARENA) { p.x = ARENA; p.vx = 0; }
    if (p.z < -ARENA) { p.z = -ARENA; p.vz = 0; } else if (p.z > ARENA) { p.z = ARENA; p.vz = 0; }
  }

  /* ================================================================== */
  /* the one kill path — same shape as src/match/index.js               */
  /* ================================================================== */

  _logDamage(victim, attackerId, amount, headshot) {
    const slot = victim.log[victim.logAt];
    victim.logAt = (victim.logAt + 1) % LOG_SLOTS;
    slot.attackerId = attackerId;
    slot.amount = amount;
    slot.at = this.now;
    slot.headshot = !!headshot;
  }

  _death(victim) {
    if (!victim.alive) return;
    const now = this.now;
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.kd = victim.deaths ? victim.kills / victim.deaths : victim.kills;
    victim.respawnAt = now + MATCH.respawnDelay;
    victim.queue.length = 0;

    const last = victim.log[(victim.logAt + LOG_SLOTS - 1) % LOG_SLOTS];
    const fresh = now - last.at <= KILL_WINDOW;
    const attacker = fresh && last.attackerId >= 0 && last.attackerId !== victim.id
      ? this.players[last.attackerId]
      : null;
    const headshot = fresh && last.headshot;
    const teamKill = !!attacker && attacker.team === victim.team;

    if (attacker && !teamKill) {
      attacker.kills++;
      attacker.streak++;
      if (attacker.streak > attacker.bestStreak) attacker.bestStreak = attacker.streak;
      attacker.score += 100 + (headshot ? 50 : 0);
      attacker.kd = attacker.deaths ? attacker.kills / attacker.deaths : attacker.kills;
      this.teams[attacker.team].score++;
      const assist = this._bestAssist(victim, attacker, now);
      if (assist) {
        assist.assists++;
        assist.score += 50;
      }
    }

    const k = this._killMsg;
    k.by = attacker ? attacker.id : -1;
    k.on = victim.id;
    k.headshot = headshot;
    this._broadcast(JSON.stringify(k));
    this._matchDirty = true;

    if (this.state === 'live' &&
        (this.teams[0].score >= this.limits.scoreLimit || this.teams[1].score >= this.limits.scoreLimit)) {
      this._endLive();
    }
  }

  /** O(LOG_SLOTS^2) over a preallocated ring. Allocates nothing. */
  _bestAssist(victim, killer, now) {
    const log = victim.log;
    const floor = MATCH.assistFraction * MAX_HP;
    let best = null;
    let bestAmount = floor;
    for (let i = 0; i < LOG_SLOTS; i++) {
      const id = log[i].attackerId;
      if (id < 0 || id === victim.id || id === killer.id) continue;
      if (now - log[i].at > MATCH.assistWindow) continue;
      const cand = this.players[id];
      if (!cand || cand.team === victim.team) continue;
      let sum = 0;
      for (let j = 0; j < LOG_SLOTS; j++) {
        if (log[j].attackerId === id && now - log[j].at <= MATCH.assistWindow) sum += log[j].amount;
      }
      if (sum >= bestAmount) {
        bestAmount = sum;
        best = cand;
      }
    }
    return best;
  }

  /* ================================================================== */
  /* phases                                                             */
  /* ================================================================== */

  _enter(phase, duration) {
    this.state = phase;
    this.timeLeft = duration;
    this._matchDirty = true;
    this.log(`phase  ${phase} round=${this.round} for ${duration}s`);
  }

  _endLive() {
    const us = this.teams[0].score;
    const them = this.teams[1].score;
    if (us > them) this.wins[0]++;
    else if (them > us) this.wins[1]++;
    this._enter('roundend', this.limits.roundEnd);
  }

  _resetRound() {
    this.teams[0].score = 0;
    this.teams[1].score = 0;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p) continue;
      p.streak = 0;
      p.logAt = 0;
      for (let k = 0; k < LOG_SLOTS; k++) {
        const s = p.log[k];
        s.attackerId = -1; s.amount = 0; s.at = -1e9; s.headshot = false;
      }
      this._respawn(p);
    }
    this._matchDirty = true;
  }

  /**
   * Wipe the match and go back to warmup.
   *
   * A ROOM MUST NOT DEAD-END. `over` used to be terminal, which was invisible
   * when a process held one room for the length of one test: you restarted the
   * process. A process now holds a default room for as long as it runs and
   * created rooms for as long as anyone is in them, so a terminal phase means a
   * match that quietly stops being joinable and never recovers — and the room
   * browser goes on advertising it.
   */
  _restart() {
    this.wins[0] = 0;
    this.wins[1] = 0;
    this.round = 1;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p) continue;
      p.kills = 0; p.deaths = 0; p.assists = 0; p.kd = 0;
      p.score = 0; p.streak = 0; p.bestStreak = 0;
    }
    this._resetRound();
    this._enter('warmup', this.limits.warmup);
  }

  _advancePhase(dt) {
    this.timeLeft -= dt;
    if (this.timeLeft > 0) return;
    this.timeLeft = 0;
    if (this.state === 'warmup') {
      this._resetRound();
      this._enter('live', this.limits.timeLimit);
    } else if (this.state === 'live') {
      this._endLive();
    } else if (this.state === 'over') {
      this._restart();
    } else if (this.state === 'roundend') {
      if (this.round >= this.limits.rounds) {
        this._enter('over', this.limits.postMatch);
        this.log(`over   wins=${this.wins[0]}-${this.wins[1]}`);
      } else {
        this._enter('intermission', this.limits.intermission);
      }
    } else if (this.state === 'intermission') {
      this.round++;
      this._resetRound();
      this._enter('live', this.limits.timeLimit);
    }
  }

  /* ================================================================== */
  /* tick                                                               */
  /* ================================================================== */

  start() {
    if (this._timer) return;
    this._last = Date.now();
    this._accum = 0;
    // Poll finer than the tick so the accumulator lands close to the 33.3 ms
    // boundary instead of quantising every snapshot to the timer's own period.
    this._timer = setInterval(() => this.pump(), 10);
    this._timer.unref?.();
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Drive the simulation from real elapsed time. Same accumulator as
   * `src/core/engine.js`: fixed dt in, no drift, and a backlog is shed rather
   * than chased into a spiral.
   */
  pump(nowMs = Date.now()) {
    const raw = Math.min(0.5, Math.max(0, (nowMs - this._last) / 1000));
    this._last = nowMs;
    this._accum += raw;
    let steps = 0;
    while (this._accum >= TICK_DT && steps < MAX_SUBSTEPS) {
      this.step(TICK_DT);
      this._accum -= TICK_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0;
  }

  /** One authoritative tick. */
  step(dt) {
    this.tick++;
    this.now += dt;

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p) this._integrate(p, dt);
    }

    // Snapshot the world for lag compensation BEFORE anything is broadcast, so
    // tick N in the ring is exactly the tick N a client is told about.
    this.hitreg.record(this.tick, this.players);

    this._advancePhase(dt);

    if (this.state === 'live' || this.state === 'warmup') {
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        if (!p || p.alive || p.respawnAt < 0 || this.now < p.respawnAt) continue;
        this._respawn(p);
      }
    }

    this._broadcastSnapshot();

    if (this._matchDirty || ++this._sinceMatch >= MATCH_HEARTBEAT) {
      this._matchDirty = false;
      this._sinceMatch = 0;
      this._broadcast(this._matchJson());
    }

    if (this.tick % PING_INTERVAL === 0) this._probeRtt();
  }

  _probeRtt() {
    for (const sess of this.sessions) {
      if (sess.conn.closed || sess.pingAt) continue;
      sess.pingId = (sess.pingId + 1) & 0x7fffffff;
      sess.pingAt = this.now;
      sess.conn.send(`{"t":"ping","id":${sess.pingId}}`);
    }
  }

  /* ================================================================== */
  /* wire                                                               */
  /* ================================================================== */

  _publicOf(p, out) {
    out.id = p.id;
    out.x = r3(p.x); out.y = r3(p.y); out.z = r3(p.z);
    out.yaw = r3(p.yaw); out.pitch = r3(p.pitch);
    out.hp = p.hp;
    out.alive = p.alive;
    out.team = p.team;
    out.st = (p.crouch ? ST.crouch : 0) | (p.sprint ? ST.sprint : 0) |
             (p.ads ? ST.ads : 0) | (p.grounded ? 0 : ST.airborne);
    return out;
  }

  /**
   * One `snap` per tick. The players array is identical for everybody, so it is
   * serialised ONCE and each client gets its own `ack` spliced onto the front.
   */
  _broadcastSnapshot() {
    const live = this._snapLive;
    live.length = 0;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p) live.push(this._publicOf(p, this._snapPlayers[i]));
    }
    const body = `,"tick":${this.tick},"players":${JSON.stringify(live)}}`;
    for (const sess of this.sessions) {
      const p = sess.player;
      if (!p || sess.conn.closed) continue;
      sess.conn.send(`{"t":"snap","ack":${p.ackSeq}${body}`);
    }
  }

  _matchJson() {
    const m = this._matchMsg;
    m.phase = this.state;
    m.round = this.round;
    m.timeLeft = Math.max(0, Math.round(this.timeLeft * 10) / 10);
    m.teams[0].score = this.teams[0].score;
    m.teams[1].score = this.teams[1].score;

    const rows = m.standings;
    rows.length = 0;
    let n = 0;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p) continue;
      const r = this._standRows[n++];
      r.id = p.id; r.name = p.name; r.team = p.team;
      r.kills = p.kills; r.deaths = p.deaths; r.assists = p.assists;
      r.kd = Math.round(p.kd * 100) / 100;
      r.score = p.score; r.streak = p.streak;
      rows.push(r);
    }
    rows.sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
    return JSON.stringify(m);
  }

  _broadcast(json) {
    for (const sess of this.sessions) {
      if (!sess.conn.closed) sess.conn.send(json);
    }
  }

  dispose() {
    this.stop();
    for (const sess of this.sessions) sess.conn.close(1001, 'server shutting down');
    this.sessions.clear();
    this.players.fill(null);
  }
}

export { HISTORY_TICKS, BTN, ST };
