# BREACHPOINT — sim host

The authoritative game server for BREACHPOINT: a resident 30 Hz tick loop that
owns movement, hit registration, health, score and match state.

This is a **deploy mirror**. It exists because a static host cannot hold a tick
loop and a browser cannot host a game server, so the sim needs somewhere that
keeps a long-lived Node process and terminates TLS. Game client lives elsewhere.

**Zero dependencies** — `node:http`, `node:crypto`, `node:events`, `node:buffer`
and nothing else. There is nothing to install; `npm start` is the whole thing.

## Run

```bash
npm start                      # binds $PORT, else 8090
node server/index.js --port=8090
```

## Environment

| Var | Purpose |
| --- | --- |
| `PORT` | port the process binds (the platform sets this) |
| `PUBLIC_HOST` | hostname clients dial, e.g. `breachpoint-sim.onrender.com` |
| `PUBLIC_PORT` | port clients dial — `443` behind TLS |
| `CONVEX_URL` | registry to publish the room set into (`rooms:sync`, every 5 s) |
| `REGION` | free-form region tag |

`PUBLIC_HOST`/`PUBLIC_PORT` are deliberately separate from `PORT`: behind a
proxy the port a client dials is not the port the process listens on, and the
client must be handed the former.

## Connect URLs

| URL | Does |
| --- | --- |
| `wss://host/` | the default public match |
| `wss://host/?room=ABCD` | an existing match by join code |
| `wss://host/?create=1&mode=TDM&max=12&name=…&private=1` | open a match; the code comes back in `welcome` |

Codes are minted here, never by the client and never by the registry — only the
process holding the room can promise it exists.
