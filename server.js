// server.js — Advanced Mafia WS Server
// Features: Rooms, Role Counts, Phase & Timer, Pause/Resume, Mafia Night Chat, Soft Reconnect

import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

/** -------------------- Constants -------------------- */
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
const MAFIA_ROLES = new Set(["pablo", "martinez", "blanco"]);

/** -------------------- State -------------------- */
const rooms = new Map(); // roomId -> { ... }

/** -------------------- Utils -------------------- */
const send = (ws, type, payload = {}) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
};

const broadcastAll = (room, type, payload = {}) => {
  for (const client of room.clients) send(client, type, payload);
};

const broadcastMafia = (room, type, payload = {}) => {
  for (const peer of room.peers.values()) {
    if (peer.ws && MAFIA_ROLES.has(peer.role)) send(peer.ws, type, payload);
  }
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

const peersPublic = (room) =>
  Array.from(room.peers.values()).map((p) => ({
    key: p.key,
    name: p.name || "—",
    alive: !!p.alive,
    connected: !!p.ws,
  }));

const roomState = (room) => ({
  roomId: room.id,
  hostKey: room.hostKey,
  phase: room.phase, // 'lobby' | 'night' | 'day'
  day: room.day,
  paused: !!room.paused,
  peers: peersPublic(room),
  settings: {
    maxPlayers: room.settings.maxPlayers,
    roleCatalog: room.settings.roleCatalog,
    roleCounts: room.settings.roleCounts,
  },
});

function setHostIfNeeded(room) {
  // If current host is disconnected or missing, promote first connected peer
  const currentHost = room.peers.get(room.hostKey);
  if (currentHost && currentHost.ws) return;
  for (const p of room.peers.values()) {
    if (p.ws) {
      room.hostKey = p.key;
      break;
    }
  }
}

function startTimer(room, ms, phase) {
  clearTimer(room);
  if (phase) room.phase = phase;
  room.timer = {
    remainingMs: Math.max(0, Number(ms) || 0),
    running: true,
    phase: room.phase,
    intervalId: setInterval(() => tickTimer(room), 1000),
  };
  broadcastAll(room, "TIMER", {
    remainingMs: room.timer.remainingMs,
    running: room.timer.running,
    phase: room.timer.phase,
  });
}

function clearTimer(room) {
  if (room.timer?.intervalId) clearInterval(room.timer.intervalId);
  room.timer = { remainingMs: 0, running: false, phase: room.phase, intervalId: null };
}

function tickTimer(room) {
  if (room.paused || !room.timer?.running) return;
  room.timer.remainingMs = Math.max(0, room.timer.remainingMs - 1000);
  broadcastAll(room, "TIMER", {
    remainingMs: room.timer.remainingMs,
    running: room.timer.running,
    phase: room.timer.phase,
  });
  if (room.timer.remainingMs === 0) {
    room.timer.running = false;
    broadcastAll(room, "TIMER", {
      remainingMs: 0,
      running: false,
      phase: room.timer.phase,
    });
  }
}

function buildDefaultCounts() {
  const counts = {};
  ROLE_CATALOG.forEach((r) => (counts[r] = 0));
  counts.citizen = 1;
  return counts;
}

/** -------------------- HTTP + WS -------------------- */
const server = http.createServer((_, res) => res.writeHead(200).end("Mafia WS OK"));
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  send(ws, "hello", { ts: Date.now() });

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const { type, payload = {} } = msg;

    // Helper: get room & peer via socket bindings
    const getRoom = () => (ws.roomId ? rooms.get(ws.roomId) : null);
    const getPeer = (room) => (ws.peerKey ? room?.peers.get(ws.peerKey) : null);

    // -------------------- CREATE_ROOM (Host) --------------------
    if (type === "CREATE_ROOM") {
      // init room
      const id = genRoomId();
      const hostKey = uuidv4();
      const room = {
        id,
        hostKey,
        phase: "lobby",
        day: 0,
        paused: false,
        clients: new Set(),
        peers: new Map(), // key -> { key, ws, name, role, alive }
        settings: {
          maxPlayers: 11,
          roleCatalog: [...ROLE_CATALOG],
          roleCounts: buildDefaultCounts(),
        },
        mafiaChat: [], // {fromKey, fromName, text, ts}
        timer: { remainingMs: 0, running: false, phase: "lobby", intervalId: null },
      };
      rooms.set(id, room);

      // add host as a peer
      const hostPeer = { key: hostKey, ws, name: "Host", role: null, alive: false };
      room.peers.set(hostKey, hostPeer);
      room.clients.add(ws);
      ws.roomId = id;
      ws.peerKey = hostKey;

      send(ws, "ROOM_CREATED", { roomId: id, hostKey, playerKey: hostKey });
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- JOIN_ROOM (Guest) --------------------
    if (type === "JOIN_ROOM") {
      const id = String(payload.roomId || "").toUpperCase();
      const room = rooms.get(id);
      if (!room) return send(ws, "ERROR", { message: "ROOM_NOT_FOUND" });

      if (room.clients.size >= room.settings.maxPlayers)
        return send(ws, "ERROR", { message: "ROOM_IS_FULL" });

      // create new peer
      const key = uuidv4();
      const peer = { key, ws, name: "Guest", role: null, alive: false };
      room.peers.set(key, peer);
      room.clients.add(ws);
      ws.roomId = room.id;
      ws.peerKey = key;

      send(ws, "JOINED", { roomId: room.id, hostKey: room.hostKey, playerKey: key });
      broadcastAll(room, "PEER_JOINED", { key });
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- RECONNECT (soft reattach by playerKey) --------------------
    if (type === "RECONNECT") {
      const id = String(payload.roomId || "").toUpperCase();
      const key = String(payload.playerKey || "");
      const room = rooms.get(id);
      if (!room) return send(ws, "ERROR", { message: "ROOM_NOT_FOUND" });
      const peer = room.peers.get(key);
      if (!peer) return send(ws, "ERROR", { message: "PEER_NOT_FOUND" });

      // Detach old socket for this peer if any
      if (peer.ws && room.clients.has(peer.ws)) {
        try { peer.ws.close(); } catch {}
        room.clients.delete(peer.ws);
      }
      // Attach new socket
      peer.ws = ws;
      room.clients.add(ws);
      ws.roomId = id;
      ws.peerKey = key;

      setHostIfNeeded(room);
      send(ws, "RECONNECTED", { roomId: room.id, hostKey: room.hostKey });
      // resend private role if already assigned
      if (peer.role) send(ws, "PRIVATE_ROLE", { role: peer.role });
      // send mafia chat history if mafia
      if (MAFIA_ROLES.has(peer.role) && room.mafiaChat.length) {
        send(ws, "MAFIA_CHAT_HISTORY", { items: room.mafiaChat });
      }
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- SET_NAME --------------------
    if (type === "SET_NAME") {
      const room = getRoom();
      if (!room) return;
      const peer = getPeer(room);
      if (!peer) return;

      const name = (payload?.name || "").toString().slice(0, 24).trim();
      if (name) peer.name = name;
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- UPDATE_SETTINGS (Host only) --------------------
    if (type === "UPDATE_SETTINGS") {
      const room = getRoom();
      if (!room) return;
      if (room.hostKey !== ws.peerKey) return send(ws, "ERROR", { message: "ONLY_HOST" });

      const n = Number(payload.maxPlayers);
      if (Number.isFinite(n)) room.settings.maxPlayers = Math.max(3, Math.min(20, n));
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- UPDATE_ROLE_COUNTS (Host only) --------------------
    if (type === "UPDATE_ROLE_COUNTS") {
      const room = getRoom();
      if (!room) return;
      if (room.hostKey !== ws.peerKey) return send(ws, "ERROR", { message: "ONLY_HOST" });

      const counts = payload?.counts || {};
      const next = {};
      const cat = new Set(room.settings.roleCatalog);
      for (const r of Object.keys(counts)) {
        if (!cat.has(r)) continue;
        let v = Number(counts[r]);
        if (!Number.isFinite(v) || v < 0) v = 0;
        next[r] = Math.min(50, Math.floor(v));
      }
      room.settings.roleCatalog.forEach((r) => {
        if (!(r in next)) next[r] = 0;
      });
      room.settings.roleCounts = next;
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- START_GAME (Host only) --------------------
    if (type === "START_GAME") {
      const room = getRoom();
      if (!room) return;
      if (room.hostKey !== ws.peerKey) return send(ws, "ERROR", { message: "ONLY_HOST_CAN_START" });
      if (room.phase !== "lobby") return send(ws, "ERROR", { message: "ALREADY_STARTED" });

      const peers = Array.from(room.peers.values()); // includes disconnected until they reconnect
      if (peers.length < 3) return send(ws, "ERROR", { message: "NEED_AT_LEAST_3_PLAYERS" });

      const counts = room.settings.roleCounts || {};
      let pool = [];
      room.settings.roleCatalog.forEach((r) => {
        const c = Math.max(0, Number(counts[r] || 0));
        for (let i = 0; i < c; i++) pool.push(r);
      });
      if (pool.length === 0) pool.push("citizen");
      while (pool.length < peers.length) pool.push("citizen");
      pool = shuffle(pool).slice(0, peers.length);

      // assign roles
      const order = shuffle(peers);
      order.forEach((p, i) => {
        p.role = pool[i];
        p.alive = true;
        if (p.ws) send(p.ws, "PRIVATE_ROLE", { role: p.role });
        // give mafia chat backlog if mafia
        if (p.ws && MAFIA_ROLES.has(p.role) && room.mafiaChat.length) {
          send(p.ws, "MAFIA_CHAT_HISTORY", { items: room.mafiaChat });
        }
      });

      room.phase = "night";
      room.day = 1;
      clearTimer(room);
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    // -------------------- PHASE / TIMER / PAUSE (Host only) --------------------
    if (type === "SET_PHASE") {
      const room = getRoom();
      if (!room) return;
      if (room.hostKey !== ws.peerKey) return send(ws, "ERROR", { message: "ONLY_HOST" });
      const phase = payload?.phase;
      if (!["lobby", "night", "day"].includes(phase)) return send(ws, "ERROR", { message: "BAD_PHASE" });
      room.phase = phase;
      broadcastAll(room, "ROOM_STATE", roomState(room));
      return;
    }

    if (type === "START_TIMER") {
      const room = getRoom();
      if (!room) return;
      if (room.hostKey !== ws.peerKey) return send(ws, "ERROR", { message: "ONLY_HOST" });
      const ms = Math.max(0, Number(payload.ms || 0));
      const phase = payload.phase && ["night", "day"].includes(payload.phase) ? payload.phase : undefined;
      startTimer(room, ms, phase);
      return;
    }

    if (type === "PAUSE_GAME") {
      const room = getRoom();
      if (!room) return;
      if (room.hostKey !== ws.peerKey) return send(ws, "ERROR", { message: "ONLY_HOST" });
      const tog = !!payload.toggle;
      room.paused = tog ? !room.paused : !!payload.value;
      sendToAllPaused(room);
      return;
    }

    // -------------------- Mafia chat (night-only) --------------------
    if (type === "MAFIA_CHAT_SEND") {
      const room = getRoom();
      if (!room) return;
      const peer = getPeer(room);
      if (!peer) return;
      if (room.phase !== "night") return; // only during night
      if (!MAFIA_ROLES.has(peer.role)) return; // only mafia roles

      const text = (payload.text || "").toString().slice(0, 400).trim();
      if (!text) return;
      const item = { fromKey: peer.key, fromName: peer.name || "Mafia", text, ts: Date.now() };
      room.mafiaChat.push(item);
      broadcastMafia(room, "MAFIA_CHAT", item);
      return;
    }

    // -------------------- PING --------------------
    if (type === "PING") {
      send(ws, "PONG", { ts: Date.now() });
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    room.clients.delete(ws);
    const peer = ws.peerKey ? room.peers.get(ws.peerKey) : null;
    if (peer && peer.ws === ws) {
      // keep peer (soft reconnect), just mark it disconnected
      peer.ws = null;
    }

    setHostIfNeeded(room);
    broadcastAll(room, "ROOM_STATE", roomState(room));

    // Cleanup: if absolutely no live sockets remain, remove room
    if (room.clients.size === 0) {
      clearTimer(room);
      rooms.delete(room.id);
    }
  });
});

function sendToAllPaused(room) {
  broadcastAll(room, "PAUSED", { paused: !!room.paused });
}

/** -------------------- Heartbeat -------------------- */
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

/** -------------------- Boot -------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("listening on", PORT));
