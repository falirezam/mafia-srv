// server.js — Minimal Mafia WS Server (Host Settings, Roles via Checkbox Whitelist)


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


// -------- UPDATE_ROLE_POOL (Host only, checkbox list) --------
// payload.enabledRoles: string[] from UI checkboxes
if (type === "UPDATE_ROLE_POOL") {
const room = rooms.get(ws.roomId);
if (!room) return;
if (room.hostId !== ws.id) return send(ws, "ERROR", { message: "ONLY_HOST" });


const input = Array.isArray(payload.enabledRoles) ? payload.enabledRoles.map(String) : [];
// whitelist + unique + order by catalog order
const catalogSet = new Set(ROLE_CATALOG);
const filtered = [];
input.forEach(r => { if (catalogSet.has(r) && !filtered.includes(r)) filtered.push(r); });
if (filtered.length < 3) return send(ws, "ERROR", { message: "ROLE_POOL_TOO_SMALL" });


room.settings.enabledRoles = filtered;
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


// Build role pool from enabled roles; pad with 'citizen' to reach player count
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
