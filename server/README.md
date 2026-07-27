# server/ — the authoritative game server

Zero dependencies. Node built-ins only (`node:http`, `node:crypto`, `node:buffer`,
`node:events`). No `package.json` lives here; the repo root already declares
`"type": "module"`, which is all the ESM in these files needs.

## Run

```sh
node server/index.js --port=8090
# options: --host=0.0.0.0  --seed=0x5eed1234
curl http://127.0.0.1:8090/health
```

Anything other than `/health` on plain HTTP answers `426`; the port only really
speaks WebSocket. Point a client at it with `?server=ws://127.0.0.1:8090`.

## Rooms and join codes

One process holds several matches. Which one a connection joins is decided from
the connect URL, once, before any game message is parsed — so a connection
belongs to exactly one room for its whole life and there is no lobby protocol.

| connect URL | lands in |
|---|---|
| `ws://host:port/` | the default public match. Always present, never reaped |
| `ws://host:port/?room=ABCD` | that match, or a `1008` close if there is no such code |
| `ws://host:port/?create=1&name=…&mode=…&max=…&private=1` | a new match; its code comes back in `welcome.room.code` |

Codes are four characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — no `0/O`,
`1/I/L`, because a code gets read aloud and retyped. They are minted here with
`node:crypto`, never from the seeded RNG: two servers started with the same
`--seed` must not mint the same codes, and a guessable code is a stranger in a
private match. Case and separators in `?room=` are normalised, so `ab-cd` works.

Bounds: **8 concurrent rooms** per process, and a created room with nobody in it
is disposed after **60 s**. Creation past the cap is a `1013` close, not a queue.

`mode` is one of `TDM | SKIRMISH | ATTRITION` and sets that room's score limit,
time limit and round count; anything else falls back to `TDM`. `max` clamps to
2–12. `name` is stripped of control characters and cut to 24.

A match that reaches `over` sits on its final scoreboard for 20 s and then
restarts from zero. A room is never a dead end — the process outlives any one
match, and a permanently finished room would go on being advertised.

## Files

| file | owns |
|---|---|
| `ws.js` | RFC 6455: handshake, masked frame decode, frame encode, fragmentation, ping/pong, close, per-connection send queue |
| `room.js` | one match: slots, the 30 Hz fixed tick, movement integration, the round state machine, scoring, respawns, the seeded RNG |
| `hitreg.js` | the per-tick position ring, rewind-to-shooter-view, capsule/head hit tests, damage |
| `lobby.js` | the `Map<code, Room>`: code minting, connect-URL routing and validation, the room cap, reaping empty rooms |
| `registry.js` | publishing the live room set to Convex over plain `fetch`. A no-op when `CONVEX_URL` is unset |
| `index.js` | entry point: http server + upgrade + the lobby + logging |

## Env

All optional. Without them the server is a complete, working game server that
simply is not listed anywhere.

| var | purpose |
|---|---|
| `CONVEX_URL` | deployment to publish the room set into (`rooms:sync`, every 5 s) |
| `PUBLIC_HOST` / `PUBLIC_PORT` | what clients should dial — behind a TLS proxy this is not what the process binds |
| `REGION` | free-form region tag |

## Messages

`TICK_RATE = 30`. Everything is JSON in a text frame.

### client -> server

| message | fields | notes |
|---|---|---|
| `hello` | `name`, `session` | once per connection. Name is stripped of control characters and cut to 16 chars. Assigns the slot and the smaller team |
| `cmd` | `seq`, `moveX`, `moveY`, `yaw`, `pitch`, `buttons` | intent only. `seq` must increase; anything `<=` the last one seen is dropped. Axes clamp to `[-1,1]`, pitch to ±88°, `buttons` to 6 bits |
| `fire` | `seq`, `origin[3]`, `dir[3]` | intent only. The server validates the origin and then does its own raycast |
| `pong` | `id` | answers the server's `ping`; this is where the RTT used for lag compensation comes from |

`buttons`: `fire=1 ads=2 jump=4 crouch=8 sprint=16 reload=32`.

### server -> client

| message | fields |
|---|---|
| `welcome` | `id`, `tick`, `tickRate`, `you`, `room` of `{code,name,mode,private,maxPlayers}` — a client that asked to CREATE learns its join code here and nowhere else |
| `snap` | `tick`, `ack`, `players[]` of `{id,x,y,z,yaw,pitch,hp,alive,team,st}` — every tick |
| `match` | `phase`, `round`, `timeLeft`, `teams[]`, `standings[]` — on any change, plus a 1 Hz heartbeat |
| `hit` | `by`, `on`, `amount`, `headshot`, `killed` |
| `kill` | `by`, `on`, `headshot` |
| `ping` | `id` — once a second |

`st`: `crouch=1 sprint=2 ads=4 airborne=8`.

`ack` is the last `cmd` seq **processed** for that client, and it is per-client:
the players array is serialised once per tick and each connection gets its own
`ack` spliced onto the front.

## Security model

The client is a source of intent and nothing else. A `cmd` contributes two axes
in `[-1,1]`, two clamped angles and six button bits; the server integrates the
position itself with its own fixed `dt`, applies its own gravity and jump, and
clamps the resulting horizontal speed against one ceiling that every movement
path funnels through — so flooding commands cannot make anyone move faster, and
there is no message that sets a position, a health value or a score. A `fire`
carries a muzzle origin only so the ray starts where the client's viewmodel is;
the server checks that claim against its own eye position for that player and
throws the shot away if it disagrees by more than 1.75 m, then casts from its
*own* eye against positions rewound to the tick the shooter actually saw.
Damage, deaths, kill credit, assists and every scoreboard number are computed
server-side and broadcast; a client that sends its own `kill`, `snap` or `match`
message is ignored, because the server has no handler for them. Every field off
the wire passes through a clamp before it is believed, malformed JSON is dropped
before it reaches the simulation, frames are capped at 64 KB (and reassembled
messages at 128 KB) so an invented 64-bit frame length cannot allocate anything,
and per-connection message rate, command-queue depth, rate of fire and send-queue
depth are all bounded — a connection that exceeds any of them is closed rather
than serviced.

## Known ceilings

- **No level collision.** `server/` cannot import `src/world`, so movement
  resolves against a flat floor at `y = 0` inside a ±60 m box, and shots are not
  occlusion-tested against geometry. Upgrade path is a serialised static BVH
  exported by `world` and swept here with the same capsule solver
  `src/physics/character.js` uses.
- **JSON on the wire.** ~3 KB/tick for 12 players. `JSON.stringify` is the only
  per-tick allocation left; everything else — snapshot rows, standings rows,
  damage rings, the position history ring — is preallocated. Upgrade path is a
  binary delta codec keyed on the same field order.
- **One process, one region.** Rooms are a `Map` in memory, so a code is only
  resolvable on the host that minted it — which is why Convex stores the code
  alongside the host that owns it. Upgrade path is a shared registry the hosts
  read as well as write.
- **The room cap is per process, not per player.** Eight concurrent matches, and
  a browser can open all eight from one tab if it tries. The cap plus the 60 s
  reap bounds the damage; a per-IP creation limit is the upgrade path if anyone
  ever bothers.
