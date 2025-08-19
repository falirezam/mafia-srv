// server.js — Mafia WS Server (Rooms + Login Flow + Role Deal + Host Panel)

import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

/** -------------------- State -------------------- */
const rooms = new Map(); // roomId -> room
const ROLE_CATALOG = [
  "pablo",
  "martinez",
  "blanco",
  "churchill",
  "doctor",
  "moreno",
  "benaparte",
  "citizen"
];

/** -------------------- Utils -------------------- */
const send = (ws, type, payload = {}) => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
};

const broadcast = (room, type, payload = {}) => {
  for (const client of room.clients) {
    send(client, type, payload);
  }
};

const genRoomId = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

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
    alive: !!p.alive
    // مهم: role رو در استیت عمومی نمی‌فرستیم که لو نره
  })),
  settings: {
    maxPlayers: room.settings.maxPlayers,
    roleCatalog: room.settings.roleCatalog,
    enabledRoles: room.settings.enabledRoles
  }
});

const leaveRoom = (ws) => {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) { ws.roomId = null; return; }
  room.clients.delete(ws);
  room.peers.delete(ws.id);

  // اگر هاست رفت، هاست جدید تعیین کن
  if (room.hostId === ws.id) {
    const left = Array.from(room.peers.keys());
    room.hostId = left[0] || null;
  }

  broadcast(room, "PEER_LEFT", { id: ws.id });
  broadcast(room, "ROOM_STATE", roomState(room));

  // اگر روم خالی شد پاکش کن
  if (room.clients.size === 0) rooms.delete(room.id);
  ws.roomId = null;
};

/** -------------------- Server -------------------- */
const server = http.createServer((req, res) => {
  res.writeHead(200).end("Mafia WS OK");
});
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
      // اگر توی روم دیگه‌ای هست، اول خارجش کن
      leaveRoom(ws);

      const id = genRoomId();
      const room = {
        id,
        hostId: ws.id,
        phase: "lobby",
        day: 0,
        clients: new Set(),
        peers: new Map(), // id -> {id, ws, name, role, alive}
        settings: {
          maxPlayers: 11,
          roleCatalog: [...ROLE_CATALOG],
          enabledRoles: [...ROLE_CATALOG]
        }
      };
      rooms.set(id, room);

      // اضافه کردن هاست به روم
      room.clients.add(ws);
      room.peers.set(ws.id, {
        id: ws.id,
        ws,
        name: ws.name || "Host",
        role: null,
        alive: false
      });
      ws.roomId = id;

      send(ws, "ROOM_CREATED", { roomId: id, hostId: room.hostId });
      broadcast(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- JOIN_ROOM (Guest) --------------------
    if (type === "JOIN_ROOM") {
      const { roomId } = payload || {};
      const room = rooms.get(String(roomId || "").toUpperCase());
      if (!room) return send(ws, "ERROR", { message: "ROOM_NOT_FOUND" });

      // ظرفیت
      if (room.clients.size >= room.settings.maxPlayers) {
        return send(ws, "ERROR", { message: "ROOM_IS_FULL" });
      }

      // اگر توی یه روم دیگه‌ای، خارج شو
      leaveRoom(ws);

      room.clients.add(ws);
      room.peers.set(ws.id, {
        id: ws.id,
        ws,
        name: ws.name || "Guest",
        role: null,
        alive: false
      });
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

    // -------------------- UPDATE_ROLE_POOL (Host only) --------------------
    if (type === "UPDATE_ROLE_POOL") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST" });

      const input = Array.isArray(payload.enabledRoles) ? payload.enabledRoles.map(String) : [];
      // whitelist + unique + حفظ ترتیب طبق کاتالوگ
      const catalogSet = new Set(room.settings.roleCatalog);
      const filtered = [];
      input.forEach(r => { if (catalogSet.has(r) && !filtered.includes(r)) filtered.push(r); });
      if (filtered.length < 3) return send(ws, "ERROR", { message: "ROLE_POOL_TOO_SMALL" });

      room.settings.enabledRoles = filtered;
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

      // pool = enabledRoles + padding با citizen تا تعداد بازیکن‌ها
      let base = [...room.settings.enabledRoles];
      let pool = shuffle(base);
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

    // -------------------- PING --------------------
    if (type === "PING") { send(ws, "PONG", {}); return; }
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
