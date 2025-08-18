// server.js — Minimal Mafia WS Server (Host Settings, Roles, Randomized Assignment)
// Node 18+ (ESM). Works on Render/Heroku/Railway. No DB (in-memory). 

import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID, randomInt } from "crypto";

/** -------------------- HTTP (health) -------------------- */
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Mafia server up");
});

/** -------------------- WS + In-memory state -------------------- */
const wss = new WebSocketServer({ server });

/** rooms: Map<roomId, Room>
 * Room = {
 *   id, hostId, phase, day,
 *   clients: Set<WebSocket>,
 *   peers: Map<wsId, { id, ws, name?:string, role?:string, alive?:boolean }>,
 *   settings: { maxPlayers:number, rolePool:string[] }
 * }
 */
const rooms = new Map();

const send = (ws, type, payload = {}) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, payload }));
};
const broadcast = (room, type, payload = {}, exceptWs = null) => {
  room.clients.forEach(c => { if (c !== exceptWs) send(c, type, payload); });
};
const pickCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const shuffle = (arr) => { // CSPRNG Fisher-Yates
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const roomState = (room) => ({
  phase: room.phase,
  day: room.day,
  settings: room.settings,
  peers: Array.from(room.peers.values()).map(p => ({ id: p.id, name: p.name || "", alive: p.alive !== false }))
});

wss.on("connection", (ws) => {
  ws.id = randomUUID();
  ws.isAlive = true;
  send(ws, "hello", { id: ws.id });

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    const { type, payload = {} } = msg;

    // -------- CREATE_ROOM (becomes Host) --------
    if (type === "CREATE_ROOM") {
      const roomId = pickCode();
      const room = {
        id: roomId,
        hostId: ws.id,
        phase: "lobby",
        day: 0,
        clients: new Set([ws]),
        peers: new Map([[ws.id, { id: ws.id, ws }]]),
        settings: {
          maxPlayers: 11,
          rolePool: [
            "pablo","juan","blanco","churchill",
            "doctor","moreno","martinez","bonaparte","chaplin",
            "citizen","citizen"
          ]
        }
      };
      rooms.set(roomId, room);
      ws.roomId = roomId;
      send(ws, "ROOM_CREATED", { roomId, hostId: ws.id });
      send(ws, "ROOM_STATE", roomState(room));
      return;
    }

    // -------- JOIN_ROOM --------
    if (type === "JOIN_ROOM") {
      const room = rooms.get(payload.roomId);
      if (!room) return send(ws, "ERROR", { message: "ROOM_NOT_FOUND" });
      if (room.clients.size >= room.settings.maxPlayers) return send(ws, "ERROR", { message: "ROOM_FULL" });
      room.clients.add(ws);
      room.peers.set(ws.id, { id: ws.id, ws });
      ws.roomId = room.id;
      send(ws, "JOINED", { roomId: room.id, hostId: room.hostId });
      send(ws, "ROOM_STATE", roomState(room));
      broadcast(room, "PEER_JOINED", { id: ws.id }, ws);
      return;
    }

    // -------- SET_NAME (guard: unique, non-empty) --------
    if (type === "SET_NAME") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const raw = String(payload.name || "").trim().slice(0, 24);
      if (!raw) return send(ws, "ERROR", { message: "NAME_REQUIRED" });
      const exists = Array.from(room.peers.values()).some(p => (p.name||"").toLowerCase() === raw.toLowerCase() && p.ws !== ws);
      if (exists) return send(ws, "ERROR", { message: "NAME_TAKEN" });
      const peer = room.peers.get(ws.id);
      if (peer) peer.name = raw;
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------- UPDATE_SETTINGS (Host only) --------
    if (type === "UPDATE_SETTINGS") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST" });
      const n = Number(payload.maxPlayers);
      if (Number.isFinite(n)) room.settings.maxPlayers = Math.max(3, Math.min(20, n));
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------- UPDATE_ROLE_POOL (Host only) --------
    if (type === "UPDATE_ROLE_POOL") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST" });
      const pool = Array.isArray(payload.rolePool) ? payload.rolePool.map(String) : [];
      if (pool.length < 3) return send(ws, "ERROR", { message: "ROLE_POOL_TOO_SMALL" });
      room.settings.rolePool = pool.slice(0, 30);
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------- START_GAME (Host only) --------
    if (type === "START_GAME") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST_CAN_START" });
      if (room.phase !== "lobby") return send(ws, "ERROR", { message: "ALREADY_STARTED" });

      const peers = Array.from(room.peers.values());
      if (peers.length < 3) return send(ws, "ERROR", { message: "NEED_AT_LEAST_3_PLAYERS" });

      // role assignment: shuffle pool (CSPRNG), pad with citizens, slice to player count
      let pool = shuffle(room.settings.rolePool);
      while (pool.length < peers.length) pool.push("citizen");
      const roles = shuffle(pool).slice(0, peers.length);

      peers.forEach((p, i) => {
        p.role = roles[i];
        p.alive = true;
        send(p.ws, "PRIVATE_ROLE", { role: p.role });
      });

      room.phase = "night";
      room.day = 1;
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------- PING/PONG --------
    if (type === "PING") { send(ws, "PONG", {}); return; }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.clients.delete(ws);
    room.peers.delete(ws.id);
    broadcast(room, "PEER_LEFT", { id: ws.id });
    if (room.clients.size === 0) rooms.delete(room.id);
  });
});

/** -------------------- Heartbeat (clean dead sockets) -------------------- */
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
