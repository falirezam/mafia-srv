// server.js
import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

/** ---------- HTTP (health) ---------- */
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Mafia server up");
});

/** ---------- WS + In-memory state ---------- */
const wss = new WebSocketServer({ server });

/** rooms: Map<roomId, {
 *   id, hostId, phase, day,
 *   clients: Set<WebSocket>,
 *   peers: Map<wsId, { id, ws, name?, role? }>
 * }> */
const rooms = new Map();

const send = (ws, type, payload = {}) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, payload }));
};
const broadcast = (room, type, payload = {}, exceptWs = null) => {
  room.clients.forEach(c => { if (c !== exceptWs) send(c, type, payload); });
};
const pickCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

wss.on("connection", (ws) => {
  ws.id = randomUUID();
  send(ws, "hello", { id: ws.id });

  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    const { type, payload = {} } = msg;

    // --- CREATE_ROOM (becomes Host) ---
    if (type === "CREATE_ROOM") {
      const roomId = pickCode();
      const room = {
        id: roomId,
        hostId: ws.id,
        phase: "lobby",
        day: 0,
        clients: new Set([ws]),
        peers: new Map([[ws.id, { id: ws.id, ws }]]),
      };
      rooms.set(roomId, room);
      ws.roomId = roomId;
      send(ws, "ROOM_CREATED", { roomId, hostId: ws.id });
      return;
    }

    // --- JOIN_ROOM ---
    if (type === "JOIN_ROOM") {
      const room = rooms.get(payload.roomId);
      if (!room) return send(ws, "ERROR", { message: "ROOM_NOT_FOUND" });
      room.clients.add(ws);
      room.peers.set(ws.id, { id: ws.id, ws });
      ws.roomId = room.id;
      send(ws, "JOINED", { roomId: room.id, hostId: room.hostId });
      broadcast(room, "PEER_JOINED", { id: ws.id }, ws);
      // optional: push a minimal ROOM_STATE for new joiner
      send(ws, "ROOM_STATE", {
        phase: room.phase,
        day: room.day,
        peers: Array.from(room.peers.keys()) // just ids for now
      });
      return;
    }

    // --- (Optional) SET_NAME for later use ---
    if (type === "SET_NAME") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const peer = room.peers.get(ws.id);
      if (peer) peer.name = String(payload.name || "").slice(0, 24);
      broadcast(room, "ROOM_STATE", {
        phase: room.phase,
        day: room.day,
        peers: Array.from(room.peers.values()).map(p => ({ id: p.id, name: p.name || "" }))
      });
      return;
    }

    // --- START_GAME (Host only) ---
    if (type === "START_GAME") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST_CAN_START" });
      // assign roles (quick demo set – expand later)
      const peers = Array.from(room.peers.values());

      // simple demo role set (expand to your scenario later)
      const baseRoles = ["pablo", "juan", "blanco", "churchill", "doctor", "moreno", "martinez", "bonaparte", "chaplin"];
      const roles = shuffle(baseRoles);
      // fill with citizens if players > roles
      while (roles.length < peers.length) roles.push("citizen");

      // assign & DM each player's role
      peers.forEach((p, i) => {
        p.role = roles[i] || "citizen";
        send(p.ws, "PRIVATE_ROLE", { role: p.role });
      });

      room.phase = "night";
      room.day = 1;

      broadcast(room, "ROOM_STATE", {
        phase: room.phase,
        day: room.day,
        peers: peers.map(p => ({
          id: p.id,
          name: p.name || "",
          alive: true
        }))
      });
      return;
    }

    // --- PING/PONG ---
    if (type === "PING") return send(ws, "PONG", {});
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

/** ---------- Boot ---------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("listening on", PORT));
