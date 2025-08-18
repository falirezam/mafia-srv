
import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Mafia server up");
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // roomId -> { id, clients:Set<WebSocket> }

const send = (ws, type, payload) => ws.send(JSON.stringify({ type, payload }));

wss.on("connection", (ws) => {
  ws.id = randomUUID();
  send(ws, "hello", { id: ws.id });

  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }

    if (msg.type === "CREATE_ROOM") {
      const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
      rooms.set(roomId, { id: roomId, clients: new Set([ws]) });
      ws.roomId = roomId;
      send(ws, "ROOM_CREATED", { roomId });
    }

    if (msg.type === "JOIN_ROOM") {
      const room = rooms.get(msg.roomId);
      if (!room) return send(ws, "ERROR", { message: "ROOM_NOT_FOUND" });
      room.clients.add(ws);
      ws.roomId = room.id;
      send(ws, "JOINED", { roomId: room.id });
      room.clients.forEach(c => c !== ws && send(c, "PEER_JOINED", { id: ws.id }));
    }

    if (msg.type === "PING") send(ws, "PONG", {});
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomId);
    if (room) {
      room.clients.delete(ws);
      room.clients.forEach(c => send(c, "PEER_LEFT", { id: ws.id }));
      if (room.clients.size === 0) rooms.delete(room.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("listening on", PORT));
