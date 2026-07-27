/**
 * Hand-rolled RFC 6455 WebSocket server. Node built-ins only.
 *
 * WHY IT LOOKS LIKE THIS
 *
 *   HOSTILE BY DEFAULT. Everything a client controls is bounded before it is
 *   believed: the frame length is checked against MAX_PAYLOAD *before* a byte is
 *   buffered for it, a fragmented message is capped in total, control frames are
 *   forced to be short and unfragmented, and an unmasked client frame is a
 *   protocol kill. An unbounded 64-bit length from a hostile client is a memory
 *   DoS, so the 64-bit path rejects anything with a non-zero high word outright.
 *
 *   ONE SEND QUEUE PER CONNECTION. A slow reader must not become the server's
 *   memory problem. Writes go straight to the socket until it says it is full,
 *   then queue; the queue is capped and a client that overruns it is closed
 *   rather than buffered forever. Snapshots are worthless when late anyway.
 *
 * API
 *   attachWebSocket(httpServer, onConnection)   onConnection(conn, req)
 *   conn.send(str)  conn.ping(id)  conn.close(code, reason)
 *   conn events: 'message' (string), 'close', 'error'
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Hard cap on ONE frame's payload. Gameplay messages are a few hundred bytes. */
export const MAX_PAYLOAD = 64 * 1024;
/** Hard cap on a reassembled fragmented message. */
export const MAX_MESSAGE = 128 * 1024;
/** Frames allowed to sit in the send queue before the peer is dropped. */
const MAX_QUEUE = 64;
/** No bytes at all from a peer for this long and it is gone. */
const IDLE_MS = 30_000;

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Server->client frames are never masked, so the header is at most 10 bytes. */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN, no RSV
  return Buffer.concat([header, payload], header.length + len);
}

export class WsConnection extends EventEmitter {
  constructor(socket, remote) {
    super();
    this.socket = socket;
    this.remote = remote;
    this.closed = false;

    this._buf = Buffer.alloc(0);
    this._fragOp = 0;
    this._frags = [];
    this._fragLen = 0;

    this._queue = [];
    this._paused = false;

    socket.setNoDelay(true);
    socket.setTimeout(IDLE_MS);
    socket.on('data', (c) => this._onData(c));
    socket.on('drain', () => this._drain());
    socket.on('timeout', () => this._fail(1001, 'idle'));
    socket.on('error', (err) => {
      this.emit('error', err);
      this._teardown();
    });
    socket.on('close', () => this._teardown());
  }

  /* ------------------------------------------------------------------ */
  /* out                                                                */
  /* ------------------------------------------------------------------ */

  /** Queue one text frame. Returns false if the peer is gone. */
  send(str) {
    if (this.closed || typeof str !== 'string') return false;
    return this._write(encodeFrame(OP.TEXT, Buffer.from(str, 'utf8')));
  }

  /** Protocol-level ping. The game also has its own `{t:"ping"}` message. */
  ping(payload = '') {
    if (this.closed) return false;
    return this._write(encodeFrame(OP.PING, Buffer.from(String(payload), 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const body = Buffer.allocUnsafe(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this._write(encodeFrame(OP.CLOSE, body));
    this.closed = true;
    this.socket.end();
    queueMicrotask(() => this._teardown());
  }

  _write(buf) {
    if (this._paused) {
      if (this._queue.length >= MAX_QUEUE) {
        // A peer this far behind will never catch up on a 30 Hz stream.
        this._fail(1009, 'backpressure');
        return false;
      }
      this._queue.push(buf);
      return true;
    }
    if (!this.socket.write(buf)) this._paused = true;
    return true;
  }

  _drain() {
    this._paused = false;
    while (this._queue.length) {
      const buf = this._queue.shift();
      if (!this.socket.write(buf)) {
        this._paused = true;
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* in                                                                 */
  /* ------------------------------------------------------------------ */

  _onData(chunk) {
    if (this.closed) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;

      const b0 = b[0];
      const b1 = b[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (b0 & 0x70) return this._fail(1002, 'rsv set');
      // RFC 6455 §5.1: every client->server frame MUST be masked.
      if (!masked) return this._fail(1002, 'unmasked client frame');

      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        // Reject the whole 64-bit range up front: never allocate for a number
        // a client made up.
        if (b.readUInt32BE(off) !== 0 || b.readUInt32BE(off + 4) > MAX_PAYLOAD) {
          return this._fail(1009, 'frame too large');
        }
        len = b.readUInt32BE(off + 4);
        off += 8;
      }
      if (len > MAX_PAYLOAD) return this._fail(1009, 'frame too large');
      if (opcode >= 0x8 && (!fin || len > 125)) return this._fail(1002, 'bad control frame');
      if (b.length < off + 4 + len) return; // mask key + payload not here yet

      const m0 = b[off], m1 = b[off + 1], m2 = b[off + 2], m3 = b[off + 3];
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        const k = i & 3;
        payload[i] = b[off + i] ^ (k === 0 ? m0 : k === 1 ? m1 : k === 2 ? m2 : m3);
      }
      off += len;
      this._buf = b.subarray(off);

      this._frame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _frame(fin, opcode, payload) {
    switch (opcode) {
      case OP.TEXT:
      case OP.BIN:
        if (this._fragOp) return this._fail(1002, 'interleaved fragment');
        if (fin) return this._deliver(opcode, payload);
        this._fragOp = opcode;
        this._frags = [payload];
        this._fragLen = payload.length;
        return;

      case OP.CONT: {
        if (!this._fragOp) return this._fail(1002, 'continuation without start');
        this._fragLen += payload.length;
        if (this._fragLen > MAX_MESSAGE) return this._fail(1009, 'message too large');
        this._frags.push(payload);
        if (!fin) return;
        const whole = Buffer.concat(this._frags, this._fragLen);
        const op = this._fragOp;
        this._fragOp = 0;
        this._frags = [];
        this._fragLen = 0;
        return this._deliver(op, whole);
      }

      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.closed) {
          this.closed = true;
          this._write(encodeFrame(OP.CLOSE, payload.subarray(0, 2)));
          this.socket.end();
        }
        this._closeCode = code;
        return this._teardown();
      }

      case OP.PING:
        return void this._write(encodeFrame(OP.PONG, payload));

      case OP.PONG:
        return void this.emit('wspong', payload);

      default:
        return this._fail(1002, `bad opcode ${opcode}`);
    }
  }

  _deliver(opcode, payload) {
    // The wire protocol is JSON text. A binary frame is not something this
    // server speaks, so say so rather than guess.
    if (opcode !== OP.TEXT) return this._fail(1003, 'text frames only');
    let str;
    try {
      str = payload.toString('utf8');
    } catch {
      return this._fail(1007, 'bad utf8');
    }
    this.emit('message', str);
  }

  _fail(code, reason) {
    this.close(code, reason);
  }

  _teardown() {
    if (this._down) return;
    this._down = true;
    this.closed = true;
    this._queue.length = 0;
    this._frags.length = 0;
    this._buf = Buffer.alloc(0);
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.emit('close', this._closeCode ?? 1006);
  }
}

/**
 * Bolt the WebSocket upgrade onto an existing `node:http` server.
 * `onConnection(conn, req)` is called BEFORE any buffered handshake body is
 * replayed, so a listener attached inside it cannot miss the first message.
 */
export function attachWebSocket(server, onConnection, { maxConnections = 64 } = {}) {
  let live = 0;

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket' || typeof key !== 'string' || key.length < 16) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (String(req.headers['sec-websocket-version'] ?? '') !== '13') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n\r\n');
      return;
    }
    if (live >= maxConnections) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    live++;
    const conn = new WsConnection(socket, `${req.socket.remoteAddress}:${req.socket.remotePort}`);
    conn.once('close', () => { live--; });
    onConnection(conn, req);
    if (head && head.length) conn._onData(head);
  });

  return { get connections() { return live; } };
}
