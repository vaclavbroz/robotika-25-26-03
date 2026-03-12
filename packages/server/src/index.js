import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorldState } from "./world-state.js";

const TICK_HZ = 20;
const tickMs = Math.round(1000 / TICK_HZ);
const SIM_DT_SECONDS = 1 / TICK_HZ;
const SNAPSHOT_INTERVAL_TICKS = TICK_HZ;
const INPUT_BUTTON_JUMP = 1 << 0;
const INPUT_BUTTON_FORWARD = 1 << 1;
const INPUT_BUTTON_BACKWARD = 1 << 2;
const INPUT_BUTTON_LEFT = 1 << 3;
const INPUT_BUTTON_RIGHT = 1 << 4;
const SIMULATION_CONFIG = {
  gravity: 24.0,
  jumpSpeed: 8.0,
  jumpCooldownSeconds: 0.35,
  groundY: 0,
  maxAcceleration: 55.0,
  maxSpeed: 9.0,
  maxBumpSpeed: 13.0,
  airControl: 0.35,
  friction: 16.0,
  airFriction: 2.0,
  worldHalfExtent: 248.0,
  playerCollisionRadius: 0.75,
  playerCollisionRestitution: 0.93,
  playerCollisionIterations: 3,
  parkedPlane: {
    x: 95,
    z: -56,
    boardingRadius: 16,
  },
  planeMinAltitude: 1.6,
  planeCruiseSpeed: 18,
  planeBoostSpeed: 18,
  planeBrakeSpeed: 10,
  planeMinSpeed: 10,
  planeTurnSpeed: 1.7,
  planeClimbRate: 14,
  planeCrashHazards: [
    { name: "airport-terminal", minX: 67, maxX: 91, minZ: -83, maxZ: -61, height: 14 },
    { name: "station-building", minX: -46, maxX: -22, minZ: 132, maxZ: 142, height: 14 },
    { name: "city", minX: -142, maxX: -76, minZ: -70, maxZ: -12, height: 36 },
    { name: "forest", minX: 63, maxX: 141, minZ: 76, maxZ: 160, height: 13 },
  ],
  staticObstacles: [
    {
      name: "airport-terminal",
      type: "rect",
      minX: 67,
      maxX: 91,
      minZ: -83,
      maxZ: -61,
    },
    {
      name: "rail-corridor",
      type: "rect",
      minX: -248,
      maxX: 248,
      minZ: 154,
      maxZ: 158,
    },
    {
      name: "station-building",
      type: "rect",
      minX: -46,
      maxX: -22,
      minZ: 132,
      maxZ: 142,
    },
  ],
};
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PORT = Number(process.env.PORT || 8010);
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_PORT = Number(process.env.CLIENT_PORT || 8000);

const world = new WorldState();

const socketsByPlayerId = new Map();
const lastSentPlayerStateById = new Map();

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, tick: world.tick, players: world.getPlayerCount() }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const upgrade = req.headers.upgrade;

  if (typeof key !== "string" || upgrade?.toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const acceptKey = createHash("sha1").update(key + WS_GUID).digest("base64");
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "\r\n",
  ];
  socket.write(headers.join("\r\n"));

  const connection = createConnection(socket);
  initPlayerSession(connection);
});

server.listen(PORT, HOST, () => {
  console.log(`[server] websocket gateway listening on ws://${HOST}:${PORT} (${TICK_HZ} Hz sim)`);
  const clientHost = resolveClientHostForStartupUrl();
  console.log(`[server] client url http://${clientHost}:${CLIENT_PORT}`);
});

setInterval(() => {
  world.simulateTick(SIM_DT_SECONDS, SIMULATION_CONFIG);
  broadcastReplicationUpdate();
  broadcastCollisionEvents();
}, tickMs);

function initPlayerSession(connection) {
  const playerId = randomUUID();
  const playerState = world.createPlayer(playerId);
  socketsByPlayerId.set(playerId, connection);
  connection.playerId = playerId;

  const snapshot = world.createSnapshot();

  connection.sendJson({
    type: "welcome",
    playerId,
    tickRate: TICK_HZ,
    snapshot,
  });

  broadcastJson(
    {
      type: "spawn",
      playerId,
      state: playerState,
    },
    { excludePlayerId: playerId },
  );

  console.log(`[server] connected playerId=${playerId} players=${world.getPlayerCount()}`);
}

function cleanupPlayerSession(connection) {
  if (connection.closed) {
    return;
  }

  connection.closed = true;
  const { playerId } = connection;
  if (!playerId) {
    return;
  }

  const removedPlayer = world.removePlayer(playerId);
  socketsByPlayerId.delete(playerId);

  if (removedPlayer) {
    broadcastJson({ type: "despawn", playerId }, { excludePlayerId: playerId });
    lastSentPlayerStateById.delete(playerId);
    console.log(`[server] disconnected playerId=${playerId} players=${world.getPlayerCount()}`);
  }
}

function broadcastReplicationUpdate() {
  if (world.tick % SNAPSHOT_INTERVAL_TICKS === 0) {
    const snapshot = world.createSnapshot();
    for (const state of snapshot.players) {
      if (!state || typeof state.playerId !== "string") {
        continue;
      }
      lastSentPlayerStateById.set(state.playerId, JSON.stringify(state));
    }
    broadcastJson({
      type: "snapshot",
      tick: snapshot.tick,
      players: snapshot.players,
    });
    return;
  }

  const changedPlayers = [];
  for (const [playerId, player] of world.players) {
    const serializedState = JSON.stringify(player);
    if (serializedState === lastSentPlayerStateById.get(playerId)) {
      continue;
    }
    lastSentPlayerStateById.set(playerId, serializedState);
    changedPlayers.push(player);
  }

  if (changedPlayers.length === 0) {
    return;
  }

  broadcastJson({
    type: "delta",
    tick: world.tick,
    players: changedPlayers,
  });
}

function broadcastCollisionEvents() {
  if (!Array.isArray(world.recentCollisions) || world.recentCollisions.length === 0) {
  } else {
    broadcastJson({
      type: "collisions",
      tick: world.tick,
      collisions: world.recentCollisions.slice(0, 24),
    });
  }

  if (!Array.isArray(world.recentPlaneCrashes) || world.recentPlaneCrashes.length === 0) {
    return;
  }

  broadcastJson({
    type: "plane_crashes",
    tick: world.tick,
    crashes: world.recentPlaneCrashes.slice(0, 12),
  });
}

function broadcastJson(payload, options = {}) {
  const encoded = JSON.stringify(payload);
  for (const [playerId, connection] of socketsByPlayerId) {
    if (options.excludePlayerId && playerId === options.excludePlayerId) {
      continue;
    }
    connection.sendText(encoded);
  }
}

function createConnection(socket) {
  const connection = {
    socket,
    buffer: Buffer.alloc(0),
    closed: false,
    playerId: null,
    sendJson(payload) {
      this.sendText(JSON.stringify(payload));
    },
    sendText(text) {
      if (this.closed || socket.destroyed) {
        return;
      }
      socket.write(encodeFrame(Buffer.from(text, "utf8"), 0x1));
    },
  };

  socket.on("data", (chunk) => {
    if (connection.closed) {
      return;
    }
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    consumeFrames(connection, (opcode, payload) => onFrame(connection, opcode, payload));
  });

  socket.on("error", (error) => {
    console.error(`[server] socket error playerId=${connection.playerId ?? "unknown"} ${error.message}`);
  });

  socket.on("close", () => cleanupPlayerSession(connection));
  socket.on("end", () => cleanupPlayerSession(connection));
  return connection;
}

function onFrame(connection, opcode, payload) {
  if (opcode === 0x8) {
    connection.socket.end(encodeFrame(payload, 0x8));
    cleanupPlayerSession(connection);
    return;
  }

  if (opcode === 0x9) {
    connection.socket.write(encodeFrame(payload, 0xA));
    return;
  }

  if (opcode !== 0x1) {
    return;
  }

  let message;
  try {
    message = JSON.parse(payload.toString("utf8"));
  } catch {
    connection.sendJson({ type: "error", code: "bad_json" });
    return;
  }

  if (!message || typeof message !== "object") {
    connection.sendJson({ type: "error", code: "bad_message" });
    return;
  }

  if (message.type === "hello") {
    const player = world.getPlayer(connection.playerId);
    if (player) {
      player.setName(message.name);
      player.setAvatar(message.avatar);
    }
    return;
  }

  if (message.type === "jump") {
    const player = world.getPlayer(connection.playerId);
    if (player) {
      player.requestJump();
    }
    return;
  }

  if (message.type === "input") {
    const player = world.getPlayer(connection.playerId);
    if (!player) {
      return;
    }

    player.applyInput(parseInputMessage(message));
    return;
  }

  if (message.type === "toggle_plane") {
    const player = world.getPlayer(connection.playerId);
    if (player) {
      player.togglePlaneMode(SIMULATION_CONFIG);
    }
  }
}

function parseInputMessage(message) {
  const buttonsBitmask =
    typeof message.buttonsBitmask === "number" && Number.isInteger(message.buttonsBitmask)
      ? message.buttonsBitmask
      : 0;

  const forward = (buttonsBitmask & INPUT_BUTTON_FORWARD) !== 0 ? 1 : 0;
  const backward = (buttonsBitmask & INPUT_BUTTON_BACKWARD) !== 0 ? 1 : 0;
  const left = (buttonsBitmask & INPUT_BUTTON_LEFT) !== 0 ? 1 : 0;
  const right = (buttonsBitmask & INPUT_BUTTON_RIGHT) !== 0 ? 1 : 0;

  return {
    moveX: right - left,
    moveZ: forward - backward,
    yaw: typeof message.yaw === "number" ? message.yaw : 0,
    pitch: typeof message.pitch === "number" ? message.pitch : 0,
    jumpRequested: (buttonsBitmask & INPUT_BUTTON_JUMP) !== 0,
  };
}

function consumeFrames(connection, onMessage) {
  let offset = 0;
  const { buffer } = connection;

  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;

    if (!fin || !masked) {
      connection.sendJson({ type: "error", code: "protocol_violation" });
      connection.socket.end();
      connection.closed = true;
      return;
    }

    let payloadLength = byte2 & 0x7f;
    let headerBytes = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerBytes = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      const lengthBig = buffer.readBigUInt64BE(offset + 2);
      if (lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        connection.sendJson({ type: "error", code: "payload_too_large" });
        connection.socket.end();
        connection.closed = true;
        return;
      }
      payloadLength = Number(lengthBig);
      headerBytes = 10;
    }

    const frameTotal = headerBytes + 4 + payloadLength;
    if (offset + frameTotal > buffer.length) {
      break;
    }

    const maskStart = offset + headerBytes;
    const payloadStart = maskStart + 4;
    const maskingKey = buffer.subarray(maskStart, payloadStart);
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + payloadLength));

    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= maskingKey[i % 4];
    }

    onMessage(opcode, payload);
    offset += frameTotal;
  }

  connection.buffer = buffer.subarray(offset);
}

function encodeFrame(payload, opcode) {
  const payloadLength = payload.length;

  if (payloadLength < 126) {
    const header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = payloadLength;
    return Buffer.concat([header, payload]);
  }

  if (payloadLength < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payloadLength), 2);
  return Buffer.concat([header, payload]);
}

function resolveLanIpv4() {
  const interfaces = networkInterfaces();
  const preferred = [];
  const others = [];

  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue;
      }
      if (
        entry.address.startsWith("192.168.") ||
        entry.address.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(entry.address)
      ) {
        preferred.push(entry.address);
      } else {
        others.push(entry.address);
      }
    }
  }

  return preferred[0] || others[0] || null;
}

function resolveClientHostForStartupUrl() {
  const fromFile = readExternalIpFromSetupFile();
  if (fromFile) {
    return fromFile;
  }

  const lanIp = resolveLanIpv4();
  return lanIp || "127.0.0.1";
}

function readExternalIpFromSetupFile() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultPath = path.resolve(scriptDir, "../../../../setup/.wsl_external_ip");
  const configuredPath = process.env.EXTERNAL_IP_FILE || defaultPath;

  if (!existsSync(configuredPath)) {
    return null;
  }

  try {
    const raw = readFileSync(configuredPath, "utf8");
    const value = raw.split(/\r?\n/)[0]?.trim();
    return value || null;
  } catch {
    return null;
  }
}
