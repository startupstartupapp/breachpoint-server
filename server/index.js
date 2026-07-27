#!/usr/bin/env node
/**
 * Entry point for the authoritative game server.
 *
 *   node server/index.js --port=8090 [--host=0.0.0.0] [--seed=0x5eed1234]
 *
 * One `node:http` server (health endpoint + the WebSocket upgrade), one `Lobby`
 * holding one or more `Room`s. Nothing here decides anything about the game: it
 * opens the socket, asks the lobby which match the connection belongs to, and
 * logs. Zero dependencies, Node built-ins only.
 *
 * Connect URLs:
 *   ws://host:port/                 the default public match (unchanged)
 *   ws://host:port/?room=ABCD       an existing match by join code
 *   ws://host:port/?create=1&…      open a new match; the code comes back in `welcome`
 */

import { createServer } from 'node:http';
import { attachWebSocket } from './ws.js';
import { TICK_RATE } from './room.js';
import { Lobby } from './lobby.js';
import { Registry } from './registry.js';

function args(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return out;
}

const opt = args(process.argv.slice(2));
/**
 * `--port` beats `$PORT` beats 8090.
 *
 * Every platform that keeps a long-lived process — Fly, Railway, Render — picks
 * the bind port itself and injects it as `$PORT`; the router then forwards :443
 * to it. Reading only `--port` means the process binds 8090, the platform health
 * check never reaches it, and the deploy fails with nothing in the log to say
 * why. DEPLOY.md has always documented `PORT` as "the port the process actually
 * binds (the platform sets this)" — this makes that true.
 *
 * It stays BELOW `--port` so `npm run server` and the smoke tests, which pass an
 * explicit port, are unaffected by a stray PORT in the environment.
 */
const port = Number.parseInt(opt.port ?? process.env.PORT ?? '8090', 10);
const host = opt.host ?? '0.0.0.0';
const seed = Number.parseInt(opt.seed ?? '0x5eed1234', opt.seed?.startsWith('0x') ? 16 : 10) || 0x5eed1234;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[server] bad port: --port=${opt.port ?? '(unset)'} PORT=${process.env.PORT ?? '(unset)'}`);
  process.exit(1);
}

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

/**
 * What clients are told to dial, which is not what we bind: behind a TLS proxy
 * the process listens on $PORT while players connect to :443 on a hostname.
 */
const registry = new Registry({
  url: process.env.CONVEX_URL,
  host: process.env.PUBLIC_HOST,
  port: Number.parseInt(process.env.PUBLIC_PORT ?? '', 10) || port,
  region: process.env.REGION ?? 'local',
  log,
});

const lobby = new Lobby({ seed, log, onChange: () => publish() });

let publishing = null;
function publish() {
  // Coalesce: several rooms can change in one tick and the registry only ever
  // wants the latest whole picture.
  if (publishing) return publishing;
  publishing = Promise.resolve().then(() => {
    publishing = null;
    return registry.sync(lobby.rows());
  });
  return publishing;
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, tickRate: TICK_RATE, players: lobby.count,
      rooms: lobby.rows(), registry: registry.enabled,
    }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('websocket only — connect with ws://host:port\n');
});

attachWebSocket(http, (conn, req) => {
  log(`open   ${conn.remote}`);
  conn.on('error', (err) => log(`error  ${conn.remote}: ${err.message}`));
  conn.on('close', (code) => log(`close  ${conn.remote} code=${code}`));
  const room = lobby.route(conn, req);
  if (!room) log(`refuse ${conn.remote} url=${String(req.url).slice(0, 80)}`);
});

http.listen(port, host, () => {
  log(`listening on ws://${host}:${port} — ${TICK_RATE} Hz, seed 0x${(seed >>> 0).toString(16)}`);
  log(registry.enabled
    ? `registry ${registry.host}:${registry.port} region=${registry.region}`
    : 'registry off — set CONVEX_URL and PUBLIC_HOST to be listed in the room browser');
  publish();
});

/** Heartbeat: proof the process is ticking, and the registry liveness signal. */
const beat = setInterval(() => {
  const rooms = lobby.rows();
  log(`beat   rooms=${rooms.length} players=${lobby.count} ` +
      rooms.map((r) => `${r.code || 'public'}:${r.players}/${r.maxPlayers}:${r.state}`).join(' '));
  publish();
}, 5000);
beat.unref();

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(0);
    closing = true;
    log(`${sig} — shutting down`);
    clearInterval(beat);
    registry.drop().finally(() => {
      lobby.dispose();
      http.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
