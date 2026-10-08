// The Hangout relay: fans player positions out to everyone in the same park.
// Attach it to the Next HTTP server so phones and other PCs only need the
// site URL. `npm run relay` still starts a standalone copy on RELAY_PORT.

import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const roomCap = Number(process.env.ROOM_CAP || 32);
const tickMs = Number(process.env.TICK_MS || 100);
const maxPayload = 2048;
const DEFAULT_ROOM = "hangout";

/** @type {Map<string, Map<string, Client>>} */
const rooms = new Map();
/** @type {WeakMap<import("ws").WebSocket, Client>} */
const members = new WeakMap();
let nextId = 1;
let online = 0;

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {string} room
 * @property {string} name
 * @property {number[]} look
 * @property {number[]} state
 * @property {boolean} dirty
 * @property {boolean} alive
 * @property {number} lastChat
 * @property {import("ws").WebSocket} socket
 */

const pickRoom = (wanted) => {
  const base = wanted || DEFAULT_ROOM;
  const existing = rooms.get(base);
  if (!existing || existing.size < roomCap) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const name = `${base}-${i}`;
    const room = rooms.get(name);
    if (!room || room.size < roomCap) return name;
  }
  return `${base}-${Date.now()}`;
};

const send = (socket, payload) => {
  if (socket.readyState === socket.OPEN) socket.send(payload);
};

const broadcast = (room, payload, except) => {
  for (const member of room.values()) {
    if (member !== except) send(member.socket, payload);
  }
};

const cleanName = (value) =>
  String(value ?? "")
    .replace(/[^\w \-']/g, "")
    .trim()
    .slice(0, 16) || `Guest ${nextId}`;

const cleanLook = (value) => {
  if (!Array.isArray(value)) return [0, 0, 0, 0, 0, 0];
  return value.slice(0, 6).map((entry) => (Number.isFinite(entry) ? Math.trunc(entry) : 0));
};

const cleanChat = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

const cleanState = (value) => {
  if (!Array.isArray(value) || value.length < 5) return null;
  const out = value.slice(0, 5).map((entry) => (Number.isFinite(entry) ? entry : 0));
  out[0] = Math.max(-20, Math.min(20, out[0]));
  out[1] = Math.max(-20, Math.min(20, out[1]));
  out[3] = Math.max(0, Math.min(3, Math.trunc(out[3])));
  out[4] = out[4] ? 1 : 0;
  return out;
};

const bindSocket = (wss) => {
  wss.on("connection", (socket) => {
    /** @type {Client | null} */
    let client = null;
    socket.on("pong", () => {
      if (client) client.alive = true;
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;

      if (message.t === "join" && !client) {
        const roomName = pickRoom(String(message.room ?? "").slice(0, 32));
        const id = `p${nextId}`;
        nextId += 1;
        client = {
          id,
          room: roomName,
          name: cleanName(message.name),
          look: cleanLook(message.look),
          state: cleanState(message.d) ?? [0, 16, 0, 0, 0],
          dirty: false,
          alive: true,
          lastChat: 0,
          socket,
        };
        let room = rooms.get(roomName);
        if (!room) {
          room = new Map();
          rooms.set(roomName, room);
        }
        const others = [...room.values()].map((member) => ({
          id: member.id,
          name: member.name,
          look: member.look,
          d: member.state,
        }));
        room.set(id, client);
        members.set(socket, client);
        online += 1;
        send(socket, JSON.stringify({ t: "welcome", id, room: roomName, players: others }));
        broadcast(
          room,
          JSON.stringify({ t: "join", p: { id, name: client.name, look: client.look, d: client.state } }),
          client,
        );
        return;
      }

      if (!client) return;
      if (message.t === "s") {
        const state = cleanState(message.d);
        if (!state) return;
        client.state = state;
        client.dirty = true;
        return;
      }

      if (message.t === "c") {
        const text = cleanChat(message.m);
        if (!text) return;
        const now = Date.now();
        if (now - client.lastChat < 400) return;
        client.lastChat = now;
        const room = rooms.get(client.room);
        if (!room) return;
        broadcast(room, JSON.stringify({ t: "c", id: client.id, name: client.name, m: text }));
      }
    });

    const leave = () => {
      if (!client) return;
      const room = rooms.get(client.room);
      if (room) {
        room.delete(client.id);
        online -= 1;
        if (room.size === 0) rooms.delete(client.room);
        else broadcast(room, JSON.stringify({ t: "leave", id: client.id }));
      }
      members.delete(socket);
      client = null;
    };
    socket.on("close", leave);
    socket.on("error", leave);
  });

  setInterval(() => {
    for (const room of rooms.values()) {
      const updates = [];
      for (const member of room.values()) {
        if (!member.dirty) continue;
        member.dirty = false;
        updates.push([member.id, ...member.state]);
      }
      if (updates.length === 0) continue;
      broadcast(room, JSON.stringify({ t: "u", u: updates, n: room.size }));
    }
  }, tickMs);

  setInterval(() => {
    for (const socket of wss.clients) {
      const member = members.get(socket);
      if (member && !member.alive) {
        socket.terminate();
        continue;
      }
      if (member) member.alive = false;
      socket.ping();
    }
  }, 15_000);
};

/**
 * @param {import("node:http").Server} httpServer
 * @param {{ paths?: string[] }} [options]
 */
export function attachRelay(httpServer, options = {}) {
  const allowed = new Set(options.paths ?? ["/relay"]);
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (!allowed.has(pathname)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  bindSocket(wss);
  return wss;
}

export function healthPayload() {
  return { ok: true, online, rooms: rooms.size };
}

export function startStandalone(port = Number(process.env.RELAY_PORT || 3001)) {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthPayload()));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  attachRelay(server, { paths: ["/", "/relay"] });
  server.listen(port, () => {
    console.log(`relay listening on ${port} (rooms of ${roomCap}, ${tickMs}ms ticks)`);
  });
  return server;
}

const startedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (startedDirectly) startStandalone();
