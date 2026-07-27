/**
 * Lag-compensated hit registration. The server decides every hit; the client
 * only ever says "I pulled the trigger, looking roughly this way".
 *
 * WHY IT LOOKS LIKE THIS
 *
 *   REWIND, DON'T GUESS. A shooter with 80 ms of latency saw the world as it
 *   was ~40 ms ago. `history` is a fixed ring of every player's capsule for the
 *   last HISTORY_TICKS ticks; a `fire` is tested against the ring slot the
 *   shooter actually saw, not against the present. This is the whole reason a
 *   moving target is hittable at all.
 *
 *   THE RING IS PREALLOCATED. One Float32Array, `HISTORY_TICKS * MAX_PLAYERS *
 *   STRIDE`, written in place every tick. There is no per-tick allocation on
 *   this path and a match cannot grow memory.
 *
 *   ORIGIN IS AN ASSERTION, NOT A FACT. The client sends the muzzle origin so
 *   the ray starts where its viewmodel is. The server checks that origin against
 *   its OWN eye position for the shooter and throws the shot away if it does not
 *   agree. A client that teleports its origin across the map to shoot through a
 *   wall gets `reason: 'origin'` and nothing else.
 *
 *   SHAPES MIRROR src/physics/math.js. `rayCapsule` (segment + radius, clipped
 *   by two end spheres) and `raySphere` are reimplemented here rather than
 *   imported — server/ may not reach into src/ — with the same solution.
 */

/** ~1.07 s of rewind at 30 Hz. The protocol asks for ~1 s. */
export const HISTORY_TICKS = 32;
/** x, y, z, height, alive */
const STRIDE = 5;
const EPS = 1e-8;

export const HITBOX = {
  radius: 0.32,
  /** Top slice of the capsule that counts as the head. */
  headHeight: 0.27,
  headRadius: 0.13,
};

export const DAMAGE = {
  base: 34,
  headMul: 2.5,
  /** Full damage inside this range, `minScale` beyond `falloffEnd`. */
  falloffStart: 30,
  falloffEnd: 90,
  minScale: 0.55,
  maxRange: 300,
};

/** Ray vs sphere. Distance along a UNIT dir, or -1. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= maxDist ? t : -1;
}

/**
 * Ray vs capsule (segment a..b, radius r). Distance along a UNIT dir, or -1.
 * Ray vs infinite cylinder, clipped by the two end spheres — same solution as
 * `rayCapsule` in src/physics/math.js.
 */
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r, maxDist) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const aox = ox - ax, aoy = oy - ay, aoz = oz - az;
  const abd = abx * dx + aby * dy + abz * dz;
  const abo = abx * aox + aby * aoy + abz * aoz;
  const abab = abx * abx + aby * aby + abz * abz;
  if (abab < EPS) return raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxDist);
  const m = abd / abab;
  const n = abo / abab;
  const qx = dx - abx * m, qy = dy - aby * m, qz = dz - abz * m;
  const sx = aox - abx * n, sy = aoy - aby * n, sz = aoz - abz * n;
  const A = qx * qx + qy * qy + qz * qz;
  const B = 2 * (qx * sx + qy * sy + qz * sz);
  const C = sx * sx + sy * sy + sz * sz - r * r;
  let best = -1;
  if (A > EPS) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t = (-B - sq) / (2 * A);
      if (t < 0) t = (-B + sq) / (2 * A);
      if (t >= 0 && t <= maxDist) {
        const k = n + t * m;
        if (k >= 0 && k <= 1) best = t;
      }
    }
  } else if (C <= 0) {
    best = 0; // parallel to the axis and already inside
  }
  const t1 = raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxDist);
  if (t1 >= 0 && (best < 0 || t1 < best)) best = t1;
  const t2 = raySphere(ox, oy, oz, dx, dy, dz, bx, by, bz, r, maxDist);
  if (t2 >= 0 && (best < 0 || t2 < best)) best = t2;
  return best;
}

export class HitRegistry {
  constructor({ maxPlayers = 12, tickRate = 30, originTolerance = 1.75 } = {}) {
    this.maxPlayers = maxPlayers;
    this.tickMs = 1000 / tickRate;
    this.originTolerance = originTolerance;

    /** The ring. Written every tick, never reallocated. */
    this.history = new Float32Array(HISTORY_TICKS * maxPlayers * STRIDE);
    /** Which tick each ring slot holds, so a stale slot is never trusted. */
    this.slotTick = new Int32Array(HISTORY_TICKS).fill(-1);

    /** Preallocated verdict. Read it synchronously, never retain it. */
    this.result = {
      ok: false,
      reason: '',
      victimId: -1,
      damage: 0,
      headshot: false,
      killed: false,
      distance: 0,
    };
  }

  /** Snapshot every slot for `tick`. Called once per tick, allocates nothing. */
  record(tick, players) {
    const slot = ((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    const base = slot * this.maxPlayers * STRIDE;
    const h = this.history;
    for (let i = 0; i < this.maxPlayers; i++) {
      const o = base + i * STRIDE;
      const p = players[i];
      if (!p) {
        h[o + 4] = 0;
        continue;
      }
      h[o] = p.x;
      h[o + 1] = p.y;
      h[o + 2] = p.z;
      h[o + 3] = p.height;
      h[o + 4] = p.alive ? 1 : 0;
    }
    this.slotTick[slot] = tick;
  }

  /** How far back this shooter's view is, in ticks, clamped to the ring. */
  rewindTicks(rttMs) {
    const ms = Number.isFinite(rttMs) && rttMs > 0 ? Math.min(rttMs, 1000) : 0;
    const t = Math.round(ms / 2 / this.tickMs);
    return Math.max(0, Math.min(HISTORY_TICKS - 2, t));
  }

  /**
   * Read player `id` as the shooter saw them `back` ticks ago into `out`.
   * Falls back to the live slot when the ring does not hold that tick.
   */
  _rewound(tick, back, id, players, out) {
    const want = tick - back;
    const slot = ((want % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    if (this.slotTick[slot] === want) {
      const o = (slot * this.maxPlayers + id) * STRIDE;
      const h = this.history;
      out.x = h[o]; out.y = h[o + 1]; out.z = h[o + 2];
      out.height = h[o + 3]; out.alive = h[o + 4] > 0.5;
      return out;
    }
    const p = players[id];
    if (!p) return null;
    out.x = p.x; out.y = p.y; out.z = p.z;
    out.height = p.height; out.alive = p.alive;
    return out;
  }

  /**
   * Resolve one `fire`. EVERY number in `ox..dz` came from the network and is
   * treated as a claim. Returns the preallocated `result`.
   *
   * ponytail: no world geometry server-side (server/ cannot import src/world),
   * so a shot is not occlusion-tested against the level — only against player
   * capsules. Ceiling: shooting through a wall registers. Upgrade path is a
   * serialised static BVH exported from `world` and loaded here.
   */
  resolve(shooter, players, ox, oy, oz, dx, dy, dz, tick, rttMs) {
    const r = this.result;
    r.ok = false;
    r.reason = '';
    r.victimId = -1;
    r.damage = 0;
    r.headshot = false;
    r.killed = false;
    r.distance = 0;

    if (!shooter || !shooter.alive) {
      r.reason = 'dead';
      return r;
    }
    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz) ||
        !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
      r.reason = 'nan';
      return r;
    }

    // --- the origin check. This is the anti-teleport gate. ---
    const ex = shooter.x;
    const ey = shooter.y + shooter.eyeHeight;
    const ez = shooter.z;
    const ddx = ox - ex, ddy = oy - ey, ddz = oz - ez;
    if (ddx * ddx + ddy * ddy + ddz * ddz > this.originTolerance * this.originTolerance) {
      r.reason = 'origin';
      return r;
    }

    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-6 || dl > 1e6) {
      r.reason = 'dir';
      return r;
    }
    const nx = dx / dl, ny = dy / dl, nz = dz / dl;

    // Shoot from the SERVER's eye, not the claimed origin: the claim only had
    // to be close enough to be plausible, it is never the source of truth.
    const back = this.rewindTicks(rttMs);
    const scratch = this._scratch ?? (this._scratch = { x: 0, y: 0, z: 0, height: 0, alive: false });

    let bestT = DAMAGE.maxRange;
    let bestId = -1;
    let bestHead = false;

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p === shooter || !p.alive) continue;
      const s = this._rewound(tick, back, p.id, players, scratch);
      if (!s || !s.alive) continue;

      const rad = HITBOX.radius;
      const a = s.y + rad;
      const b = s.y + Math.max(s.height - rad, rad);
      const bodyT = rayCapsule(ex, ey, ez, nx, ny, nz, s.x, a, s.z, s.x, b, s.z, rad, bestT);
      const headT = raySphere(
        ex, ey, ez, nx, ny, nz,
        s.x, s.y + s.height - HITBOX.headHeight * 0.5, s.z,
        HITBOX.headRadius + rad * 0.35, bestT
      );
      let t = -1;
      let head = false;
      if (headT >= 0 && (bodyT < 0 || headT <= bodyT + 1e-4)) {
        t = headT;
        head = true;
      } else if (bodyT >= 0) {
        t = bodyT;
      }
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      bestId = p.id;
      bestHead = head;
    }

    if (bestId < 0) {
      r.reason = 'miss';
      return r;
    }

    const victim = players[bestId];
    let scale = 1;
    if (bestT > DAMAGE.falloffStart) {
      const k = Math.min(1, (bestT - DAMAGE.falloffStart) / (DAMAGE.falloffEnd - DAMAGE.falloffStart));
      scale = 1 + k * (DAMAGE.minScale - 1);
    }
    const amount = Math.max(1, Math.round(DAMAGE.base * scale * (bestHead ? DAMAGE.headMul : 1)));

    // Damage is applied HERE, to the server's copy of the health. The client is
    // never asked and its answer would not be read.
    victim.hp = Math.max(0, victim.hp - amount);

    r.ok = true;
    r.victimId = bestId;
    r.damage = amount;
    r.headshot = bestHead;
    r.killed = victim.hp <= 0;
    r.distance = bestT;
    return r;
  }
}
