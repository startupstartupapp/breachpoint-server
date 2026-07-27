/**
 * REGISTRY — publish this host's live matches to Convex.
 *
 * DEPLOY.md has always said the sim host heartbeats `rooms:heartbeat`; nothing
 * actually did it, which is why the room browser was permanently empty. This is
 * that heartbeat, and now that a process holds several matches it publishes the
 * whole set in one call so a match that ended disappears immediately instead of
 * ageing out over twenty seconds.
 *
 * NO DEPENDENCIES, AND NO OPINIONS WHEN UNCONFIGURED. `CONVEX_URL` absent means
 * `post()` is a no-op that resolves — a local `npm run server` is a complete,
 * working game server with no cloud anything, and it must stay that way. A
 * failing deployment logs once per failure and never rejects into the tick loop.
 */

const TIMEOUT_MS = 5000;
/**
 * Quietest useful interval for repeating a registry failure.
 *
 * Deduping on the message text does not work: Convex stamps every error with a
 * fresh request id, so "same error" never looks the same twice and a
 * misconfigured deployment writes a line every five seconds forever. Time is
 * the thing being rate-limited, so rate-limit on time.
 */
const WARN_EVERY_MS = 60_000;

export class Registry {
  constructor({ url, host, port, region = 'local', log = () => {} } = {}) {
    this.url = typeof url === 'string' ? url.replace(/\/+$/, '') : '';
    this.host = host;
    this.port = port;
    this.region = region;
    this.log = log;
    this.enabled = !!this.url && !!host;
    this._inflight = false;
    this._warnedAt = 0;
  }

  /** Publish the current room set. Never throws, never rejects. */
  async sync(rooms) {
    if (!this.enabled) return false;
    // One at a time: a slow deployment must not stack up a queue of heartbeats
    // that all describe a state we have already left.
    if (this._inflight) return false;
    this._inflight = true;
    try {
      await this._post('rooms:sync', {
        host: this.host, port: this.port, region: this.region, rooms,
      });
      this._warnedAt = 0;
      return true;
    } catch (err) {
      const now = Date.now();
      if (now - this._warnedAt >= WARN_EVERY_MS) {
        this._warnedAt = now;
        this.log(`registry unreachable: ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      return false;
    } finally {
      this._inflight = false;
    }
  }

  /** Best-effort deregistration on shutdown, so no ghost rooms are listed. */
  async drop() {
    if (!this.enabled) return;
    try {
      await this._post('rooms:sync', {
        host: this.host, port: this.port, region: this.region, rooms: [],
      });
    } catch { /* going away anyway */ }
  }

  async _post(path, args) {
    const res = await fetch(`${this.url}/api/mutation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, args, format: 'json' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Convex answers 200 with {status:"error"} for a function-level failure.
    if (body?.status === 'error') throw new Error(body.errorMessage ?? 'mutation failed');
    return body?.value ?? null;
  }
}
