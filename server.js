// server.js — Mafia WS Server (Rooms + Login/Host/Guest + Role Counts)

import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

/** -------------------- Constants & State -------------------- */
const ROLE_CATALOG = [
  "pablo",
  "martinez",
  "blanco",
  "churchill",
  "doctor",
  "moreno",
  "benaparte",
  "citizen",
];

const rooms = new Map(); // roomId -> room

/** -------------------- Utils -------------------- */
const send = (ws, type, payload = {}) => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
};

const broadcast = (room, type, payload = {}) => {
  for (const client of room.clients) send(client, type, payload);
};

const genRoomId = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const roomState = (room) => ({
  roomId: room.id,
  hostId: room.hostId,
  phase: room.phase, // 'lobby' | 'night' | 'day' ...
  day: room.day,
  peers: Array.from(room.peers.values()).map((p) => ({
    id: p.id,
    name: p.name || "—",
    alive: !!p.alive,
  })),
  settings: {
    maxPlayers: room.settings.maxPlayers,
    roleCatalog: room.settings.roleCatalog,
    roleCounts: room.settings.roleCounts, // <-- NEW
  },
});

const leaveRoom = (ws) => {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  ws.roomId = null;
  if (!room) return;

  room.clients.delete(ws);
  room.peers.delete(ws.id);

  // If host left, promote first remaining peer as host
  if (room.hostId === ws.id) {
    const remaining = Array.from(room.peers.keys());
    room.hostId = remaining[0] || null;
  }

  broadcast(room, "PEER_LEFT", { id: ws.id });
  broadcast(room, "ROOM_STATE", roomState(room));

  if (room.clients.size === 0) rooms.delete(room.id);
};

/** -------------------- HTTP + WS -------------------- */
const server = http.createServer((_, res) => res.writeHead(200).end("Mafia WS OK"));
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.id = uuidv4();
  ws.isAlive = true;
  ws.name = null;
  ws.on("pong", () => (ws.isAlive = true));
  send(ws, "hello", { id: ws.id });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const { type, payload = {} } = msg;

    // -------------------- CREATE_ROOM (Host) --------------------
    if (type === "CREATE_ROOM") {
      leaveRoom(ws);

      // default role counts (host can change in UI)
      const defaultCounts = {};
      ROLE_CATALOG.forEach((r) => (defaultCounts[r] = 0));
      // give a sane default: 1 citizen (others 0)
      defaultCounts.citizen = 1;

      const id = genRoomId();
      const room = {
        id,
        hostId: ws.id,
        phase: "lobby",
        day: 0,
        clients: new Set(),
        peers: new Map(), // id -> { id, ws, name, role, alive }
        settings: {
          maxPlayers: 11,
          roleCatalog: [...ROLE_CATALOG],
          roleCounts: defaultCounts, // <-- NEW
        },
      };
      rooms.set(id, room);

      room.clients.add(ws);
      room.peers.set(ws.id, { id: ws.id, ws, name: ws.name || "Host", role: null, alive: false });
      ws.roomId = id;

      send(ws, "ROOM_CREATED", { roomId: id, hostId: room.hostId });
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- JOIN_ROOM (Guest) --------------------
    if (type === "JOIN_ROOM") {
      const roomId = String(payload.roomId || "").toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return send(ws, "ERROR", { message: "ROOM_NOT_FOUND" });

      if (room.clients.size >= room.settings.maxPlayers)
        return send(ws, "ERROR", { message: "ROOM_IS_FULL" });

      leaveRoom(ws);
      room.clients.add(ws);
      room.peers.set(ws.id, { id: ws.id, ws, name: ws.name || "Guest", role: null, alive: false });
      ws.roomId = room.id;

      send(ws, "JOINED", { roomId: room.id, hostId: room.hostId });
      broadcast(room, "PEER_JOINED", { id: ws.id });
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- SET_NAME --------------------
    if (type === "SET_NAME") {
      const name = (payload?.name || "").toString().slice(0, 24).trim();
      ws.name = name || ws.name || null;

      if (ws.roomId) {
        const room = rooms.get(ws.roomId);
        const peer = room?.peers.get(ws.id);
        if (peer) peer.name = ws.name || peer.name;
        if (room) broadcast(room, "ROOM_STATE", roomState(room));
      } else {
        send(ws, "NAME_SET", { name: ws.name || "" });
      }
      return;
    }

    // -------------------- UPDATE_SETTINGS (Host only) --------------------
    if (type === "UPDATE_SETTINGS") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST" });

      const n = Number(payload.maxPlayers);
      if (Number.isFinite(n)) room.settings.maxPlayers = Math.max(3, Math.min(20, n));

      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- UPDATE_ROLE_COUNTS (Host only) --------------------
    // payload.counts: { [role]: number >= 0 }
    if (type === "UPDATE_ROLE_COUNTS") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST" });

      const counts = payload?.counts || {};
      const next = {};
      const catalogSet = new Set(room.settings.roleCatalog);
      for (const r of Object.keys(counts)) {
        if (!catalogSet.has(r)) continue;
        let v = Number(counts[r]);
        if (!Number.isFinite(v) || v < 0) v = 0;
        next[r] = Math.min(50, Math.floor(v)); // cap to 50 to avoid nonsense
      }
      // ensure every catalog role has a number
      room.settings.roleCatalog.forEach((r) => {
        if (!(r in next)) next[r] = 0;
      });

      room.settings.roleCounts = next;
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- START_GAME (Host only) --------------------
    if (type === "START_GAME") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST_CAN_START" });
      if (room.phase !== "lobby") return send(ws, "ERROR", { message: "ALREADY_STARTED" });

      const peers = Array.from(room.peers.values());
      if (peers.length < 3) return send(ws, "ERROR", { message: "NEED_AT_LEAST_3_PLAYERS" });

      const counts = room.settings.roleCounts || {};
      // Build role pool by counts
      let pool = [];
      room.settings.roleCatalog.forEach((r) => {
        const c = Math.max(0, Number(counts[r] || 0));
        for (let i = 0; i < c; i++) pool.push(r);
      });

      // Fallbacks: pad with citizens or trim
      if (pool.length === 0) pool.push("citizen");
      while (pool.length < peers.length) pool.push("citizen");

      pool = shuffle(pool).slice(0, peers.length);

      peers.forEach((p, i) => {
        p.role = pool[i];
        p.alive = true;
        send(p.ws, "PRIVATE_ROLE", { role: p.role });
      });

      room.phase = "night";
      room.day = 1;
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- PING --------------------
    if (type === "PING") return send(ws, "PONG", {});
  });

  ws.on("close", () => leaveRoom(ws));
});

/** -------------------- Heartbeat -------------------- */
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(interval));

/** -------------------- Boot -------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("listening on", PORT));
Index.html
Updated Host panel to use role counts (number inputs) instead of checkboxes.
The “Start Game” button is auto-disabled until total selected roles = current players (so you don’t accidentally under/over-assign).
Default WS URL points to Render.

html
Copy
Edit
