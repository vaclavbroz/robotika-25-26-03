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
const AIRPORT_CENTER = { x: 122, z: -88 };
const AIRPORT_RUNWAY_LENGTH = 118;
const AIRPORT_RUNWAY_WIDTH = 24;
const AIRPORT_AI_PARK_HOLD_SECONDS = 30;
const AIRPORT_AI_TAXI_TO_PARK_SPEED = 10;
const AIRPORT_AI_TAXI_TO_RUNWAY_SPEED = 11;
const AIRPORT_AI_TAKEOFF_AIRBORNE_ALTITUDE = 4.5;
const AIRPORT_AI_DEPARTURE_CYCLE_START = 0.56;
const AIRPORT_AIRLINER_BOARDING_RADIUS = 8;
const AIRPORT_RUNWAY_WORLD_Y = 0.22;
const INPUT_BUTTON_JUMP = 1 << 0;
const INPUT_BUTTON_FORWARD = 1 << 1;
const INPUT_BUTTON_BACKWARD = 1 << 2;
const INPUT_BUTTON_LEFT = 1 << 3;
const INPUT_BUTTON_RIGHT = 1 << 4;
const INPUT_BUTTON_BRAKE = 1 << 5;
const SIM_BUS_ROUTE = [
  { x: 67, z: -76, stop: { duration: 2.6 } },
  { x: -132, z: -88 },
  { x: -132, z: -36 },
  { x: -90, z: -36, stop: { duration: 2.4 } },
  { x: -34, z: -36, stop: { duration: 3.0 } },
  { x: -34, z: 146 },
];
const SIM_AIRPORT_TRAFFIC_CONFIGS = [
  {
    id: "airliner-0",
    runwayOffsetX: -3.2,
    cycleDuration: 40,
    phase: 0.0,
    cruiseAltitude: 34,
    approachDistance: 124,
    departureDistance: 158,
  },
  {
    id: "airliner-1",
    runwayOffsetX: 3.4,
    cycleDuration: 40,
    phase: 0.2,
    cruiseAltitude: 42,
    approachDistance: 142,
    departureDistance: 176,
  },
  {
    id: "airliner-2",
    runwayOffsetX: -1.4,
    cycleDuration: 40,
    phase: 0.4,
    cruiseAltitude: 30,
    approachDistance: 116,
    departureDistance: 150,
  },
  {
    id: "airliner-3",
    runwayOffsetX: 1.6,
    cycleDuration: 40,
    phase: 0.6,
    cruiseAltitude: 38,
    approachDistance: 136,
    departureDistance: 168,
  },
  {
    id: "airliner-4",
    runwayOffsetX: 0,
    cycleDuration: 40,
    phase: 0.8,
    cruiseAltitude: 46,
    approachDistance: 156,
    departureDistance: 188,
  },
];
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
    x: AIRPORT_CENTER.x,
    z: AIRPORT_CENTER.z,
    boardingRadius: 16,
  },
  parkedCar: {
    x: 8,
    z: 6,
    yaw: Math.PI * 0.35,
    boardingRadius: 12,
  },
  runway: {
    centerX: AIRPORT_CENTER.x,
    centerZ: AIRPORT_CENTER.z,
    width: AIRPORT_RUNWAY_WIDTH,
    length: AIRPORT_RUNWAY_LENGTH,
  },
  planeMinAltitude: 1.6,
  planeCruiseSpeed: 18,
  planeBoostSpeed: 18,
  planeBrakeSpeed: 10,
  planeBrakeFallRate: 9,
  planeMinSpeed: 10,
  planeTurnSpeed: 1.7,
  planeClimbRate: 14,
  carMaxForwardSpeed: 24,
  carMaxReverseSpeed: 9,
  carAcceleration: 18,
  carBrakeSpeed: 24,
  carTurnSpeed: 2.7,
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
  bus: {
    route: SIM_BUS_ROUTE,
    speed: 11,
    segmentIndex: 0,
    segmentProgress: 0,
    stopHold: 0,
    stopYaw: Math.PI,
    isStopped: false,
    x: SIM_BUS_ROUTE[0].x,
    z: SIM_BUS_ROUTE[0].z,
    yaw: Math.PI,
    boardingRadius: 6.2,
  },
  airportAirliners: createAirportAirliners(),
};
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PORT = Number(process.env.PORT || 9003);
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_PORT = Number(process.env.CLIENT_PORT || 8003);
const DEV_AUTO_RESTART = process.env.DEV_AUTO_RESTART === "1";
const DEV_RESTART_NOTICE_MS = Number(process.env.DEV_RESTART_NOTICE_MS || 1400);
const DEV_RESTART_SHUTDOWN_GRACE_MS = 250;
const QUIET_STARTUP_LOGS = process.env.QUIET_STARTUP_LOGS === "1";

const world = new WorldState();

const socketsByPlayerId = new Map();
const lastSentPlayerStateById = new Map();
let airportDepartureInProgress = null;
let airportElapsedTime = 0;
let lastSentAirportTrafficState = "";

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
  if (!QUIET_STARTUP_LOGS) {
    console.log(`[server] websocket gateway listening on ws://${HOST}:${PORT} (${TICK_HZ} Hz sim)`);
    const clientHost = resolveClientHostForStartupUrl();
    console.log(`[server] client url http://${clientHost}:${CLIENT_PORT}`);
  }
});

const simulationTimer = setInterval(() => {
  updateBusMotion(SIM_DT_SECONDS);
  updateAirportAirTraffic(SIM_DT_SECONDS);
  world.simulateTick(SIM_DT_SECONDS, SIMULATION_CONFIG);
  broadcastReplicationUpdate();
  broadcastCollisionEvents();
}, tickMs);

let shuttingDown = false;

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  clearInterval(simulationTimer);

  if (DEV_AUTO_RESTART) {
    broadcastJson({
      type: "serverRestarting",
      delayMs: DEV_RESTART_NOTICE_MS,
      message: "Server update in progress. Reconnecting soon.",
    });
    setTimeout(closeSocketsAndExit, DEV_RESTART_SHUTDOWN_GRACE_MS).unref();
    return;
  }

  closeSocketsAndExit();

  function closeSocketsAndExit() {
    for (const connection of socketsByPlayerId.values()) {
      connection.closed = true;
      if (!connection.socket.destroyed) {
        connection.socket.end();
        connection.socket.destroy();
      }
    }
    socketsByPlayerId.clear();
    lastSentPlayerStateById.clear();

    server.close(() => {
      process.exit(exitCode);
    });

    setTimeout(() => {
      process.exit(exitCode);
    }, 1000).unref();
  }
}

function initPlayerSession(connection) {
  const playerId = randomUUID();
  const playerState = world.createPlayer(playerId);
  socketsByPlayerId.set(playerId, connection);
  connection.playerId = playerId;

  const snapshot = createReplicationSnapshot();

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
  const airportTraffic = serializeAirportTraffic();
  const serializedAirportTraffic = JSON.stringify(airportTraffic);

  if (world.tick % SNAPSHOT_INTERVAL_TICKS === 0) {
    const snapshot = createReplicationSnapshot();
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
      parkedCar: snapshot.parkedCar,
      airportTraffic: snapshot.airportTraffic,
    });
    lastSentAirportTrafficState = serializedAirportTraffic;
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

  const airportTrafficChanged = serializedAirportTraffic !== lastSentAirportTrafficState;
  if (changedPlayers.length === 0 && !airportTrafficChanged) {
    return;
  }

  lastSentAirportTrafficState = serializedAirportTraffic;

  broadcastJson({
    type: "delta",
    tick: world.tick,
    players: changedPlayers,
    parkedCar: serializeParkedCar(),
    airportTraffic,
  });
}

function createReplicationSnapshot() {
  const snapshot = world.createSnapshot();
  return {
    ...snapshot,
    parkedCar: serializeParkedCar(),
    airportTraffic: serializeAirportTraffic(),
  };
}

function serializeParkedCar() {
  const parkedCar = SIMULATION_CONFIG.parkedCar;
  if (!parkedCar) {
    return null;
  }

  return {
    x: Number(parkedCar.x) || 0,
    z: Number(parkedCar.z) || 0,
    yaw: Number.isFinite(parkedCar.yaw) ? parkedCar.yaw : 0,
    boardingRadius: Number(parkedCar.boardingRadius) || 12,
  };
}

function serializeAirportTraffic() {
  return Array.isArray(SIMULATION_CONFIG.airportAirliners)
    ? SIMULATION_CONFIG.airportAirliners.map((plane) => ({
        id: plane.id,
        state: plane.state,
        x: Number(plane.x) || 0,
        y: Number(plane.y) || 0,
        z: Number(plane.z) || 0,
        yaw: Number.isFinite(plane.yaw) ? plane.yaw : 0,
        pitch: Number.isFinite(plane.pitch) ? plane.pitch : 0,
        onGround: plane.onGround === true,
        boardingRadius: Number.isFinite(plane.boardingRadius) ? plane.boardingRadius : AIRPORT_AIRLINER_BOARDING_RADIUS,
      }))
    : [];
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

  if (message.type === "toggle_plane" || message.type === "toggle_vehicle") {
    const player = world.getPlayer(connection.playerId);
    if (player) {
      player.toggleVehicleMode(SIMULATION_CONFIG);
    }
    return;
  }

  if (message.type === "report_plane_collision") {
    const player = world.getPlayer(connection.playerId);
    if (player?.inPlane) {
      player.triggerPlaneCrash("air-traffic-collision");
    }
  }
}

function createAirportAirliners() {
  const parkingAltitude = 1.6;
  const runwayY = AIRPORT_RUNWAY_WORLD_Y + parkingAltitude;
  const parkingYaw = -Math.PI / 2;
  const parkingStands = buildAirportParkStands(SIM_AIRPORT_TRAFFIC_CONFIGS.length);
  return SIM_AIRPORT_TRAFFIC_CONFIGS.map((planeConfig, index) => {
    const parking = parkingStands[index];
    return {
      ...planeConfig,
      state: "approach",
      parkingX: parking.x,
      parkingY: runwayY,
      parkingZ: parking.z,
      parkingYaw,
      departureAirborneReleased: false,
      holdRemaining: 0,
      parkHoldSeconds: AIRPORT_AI_PARK_HOLD_SECONDS,
      taxiToParkSpeed: AIRPORT_AI_TAXI_TO_PARK_SPEED,
      taxiToRunwaySpeed: AIRPORT_AI_TAXI_TO_RUNWAY_SPEED,
      takeoffStartTime: 0,
      runwayAlignedX: AIRPORT_CENTER.x + planeConfig.runwayOffsetX,
      runwayTurnState: "idle",
      boardingRadius: AIRPORT_AIRLINER_BOARDING_RADIUS,
      x: AIRPORT_CENTER.x + planeConfig.runwayOffsetX,
      y: AIRPORT_RUNWAY_WORLD_Y + planeConfig.cruiseAltitude,
      altitude: planeConfig.cruiseAltitude,
      z: AIRPORT_CENTER.z - AIRPORT_RUNWAY_LENGTH * 0.5 - planeConfig.approachDistance + 8,
      yaw: Math.PI,
      pitch: 0,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      onGround: false,
      wasOnRunway: false,
    };
  });
}

function buildAirportParkStands(count) {
  const stands = [];
  const runwayLeftX = AIRPORT_CENTER.x - AIRPORT_RUNWAY_WIDTH * 0.5 - 8;
  const standStartZ = AIRPORT_CENTER.z + AIRPORT_RUNWAY_LENGTH * 0.5 - 14;
  const standSpacingZ = 16;
  const terminalBounds = {
    xMin: AIRPORT_CENTER.x - 43,
    xMax: AIRPORT_CENTER.x - 15,
    zMin: AIRPORT_CENTER.z + 5,
    zMax: AIRPORT_CENTER.z + 19,
  };

  for (let i = 0; i < count; i += 1) {
    const x = runwayLeftX;
    let z = standStartZ - i * standSpacingZ;
    let attempts = 0;
    while (
      x >= terminalBounds.xMin &&
      x <= terminalBounds.xMax &&
      z >= terminalBounds.zMin &&
      z <= terminalBounds.zMax &&
      attempts < 30
    ) {
      z -= standSpacingZ;
      attempts += 1;
    }
    stands.push({ x, z });
  }

  return stands;
}

function updateAirportAirTraffic(dtSeconds) {
  const thresholdNorth = AIRPORT_CENTER.z - AIRPORT_RUNWAY_LENGTH * 0.5 + 8;
  const thresholdSouth = AIRPORT_CENTER.z + AIRPORT_RUNWAY_LENGTH * 0.5 - 8;
  const runwayBaseY = 0;
  const delta = Math.max(0, dtSeconds);
  const runwayEndZ = AIRPORT_CENTER.z + AIRPORT_RUNWAY_LENGTH * 0.5 - 1.2;
  const runwayEndOffset = runwayEndZ - thresholdSouth;
  airportElapsedTime += delta;

  for (const plane of SIMULATION_CONFIG.airportAirliners) {
    if (plane.state === "taxiToPark") {
      const taxiAxis = plane.taxiAxis === "z" ? "z" : "x";
      const targetReached = moveAirportPlaneAxisAligned(
        plane,
        plane.parkingX,
        plane.parkingY,
        plane.parkingZ,
        plane.taxiToParkSpeed || AIRPORT_AI_TAXI_TO_PARK_SPEED,
        delta,
        taxiAxis,
      );
      plane.pitch = 0;
      plane.onGround = true;
      plane.altitude = plane.parkingY - AIRPORT_RUNWAY_WORLD_Y;
      if (targetReached && taxiAxis === "x") {
        plane.taxiAxis = "z";
        continue;
      }
      if (targetReached) {
        plane.state = "holding";
        plane.holdRemaining = plane.parkHoldSeconds ?? AIRPORT_AI_PARK_HOLD_SECONDS;
        plane.x = plane.parkingX;
        plane.y = plane.parkingY;
        plane.z = plane.parkingZ;
        plane.yaw = plane.parkingYaw;
        plane.taxiAxis = "x";
        plane.runwayTurnState = "idle";
        plane.wasOnRunway = false;
        if (airportDepartureInProgress === plane) {
          airportDepartureInProgress = null;
        }
      }
      continue;
    }

    if (plane.state === "taxiToRunway") {
      const runwayAlignedX = plane.runwayAlignedX ?? (AIRPORT_CENTER.x + plane.runwayOffsetX);
      const isAligningRunway = plane.runwayTurnState !== "downRunway";
      const targetX = runwayAlignedX;
      const targetZ = isAligningRunway ? plane.parkingZ : runwayEndZ;
      const targetYaw = isAligningRunway ? plane.parkingYaw + Math.PI / 2 : plane.parkingYaw;
      const targetReached = moveAirportPlaneTowards(
        plane,
        targetX,
        plane.parkingY,
        targetZ,
        plane.taxiToRunwaySpeed || AIRPORT_AI_TAXI_TO_RUNWAY_SPEED,
        delta,
        targetYaw,
      );
      plane.pitch = 0;
      plane.onGround = true;
      plane.altitude = plane.y - AIRPORT_RUNWAY_WORLD_Y;
      if (!targetReached) {
        plane.yaw = targetYaw;
        continue;
      }
      if (isAligningRunway) {
        if (airportDepartureInProgress !== plane) {
          plane.runwayTurnState = "runwayQueued";
          plane.yaw = targetYaw;
          continue;
        }
        plane.runwayTurnState = "downRunway";
        continue;
      }

      plane.state = "departing";
      plane.takeoffStartTime = airportElapsedTime;
      plane.departureAirborneReleased = false;
      plane.wasOnRunway = false;
      plane.runwayTurnState = "idle";
      continue;
    }

    if (plane.state === "holding") {
      plane.holdRemaining -= delta;
      plane.x = plane.parkingX;
      plane.y = plane.parkingY;
      plane.z = plane.parkingZ;
      plane.yaw = plane.parkingYaw;
      plane.pitch = 0;
      plane.velocityX = 0;
      plane.velocityY = 0;
      plane.velocityZ = 0;
      plane.onGround = true;
      plane.altitude = plane.parkingY - AIRPORT_RUNWAY_WORLD_Y;
      if (plane.holdRemaining <= 0 && !airportDepartureInProgress) {
        plane.state = "taxiToRunway";
        plane.takeoffStartTime = airportElapsedTime;
        plane.runwayTurnState = "alignToRunway";
        airportDepartureInProgress = plane;
      }
      continue;
    }

    if (plane.state === "departing" && airportElapsedTime >= plane.takeoffStartTime + plane.cycleDuration) {
      if (airportDepartureInProgress === plane) {
        airportDepartureInProgress = null;
      }
      plane.state = "approach";
    }

    const departureProgress = (airportElapsedTime - plane.takeoffStartTime) / plane.cycleDuration;
    const cycle = plane.state === "departing"
      ? AIRPORT_AI_DEPARTURE_CYCLE_START + Math.max(0, Math.min(1, departureProgress)) * (1 - AIRPORT_AI_DEPARTURE_CYCLE_START)
      : ((airportElapsedTime / plane.cycleDuration) + plane.phase) % 1;
    const sample = sampleAirportTrafficState(plane, cycle, thresholdNorth, thresholdSouth);
    const nextTime = airportElapsedTime + delta;
    const nextDepartureProgress = (nextTime - plane.takeoffStartTime) / plane.cycleDuration;
    const nextCycle = plane.state === "departing"
      ? AIRPORT_AI_DEPARTURE_CYCLE_START + Math.max(0, Math.min(1, nextDepartureProgress)) * (1 - AIRPORT_AI_DEPARTURE_CYCLE_START)
      : ((nextTime / plane.cycleDuration) + plane.phase) % 1;
    const nextSample = sampleAirportTrafficState(plane, nextCycle, thresholdNorth, thresholdSouth);
    if (plane.state === "departing") {
      sample.z += runwayEndOffset;
      nextSample.z += runwayEndOffset;
    }

    const dx = nextSample.x - sample.x;
    const dy = nextSample.y - sample.y;
    const dz = nextSample.z - sample.z;
    const horizontalLength = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, Math.max(0.001, horizontalLength));
    plane.x = sample.x;
    plane.altitude = sample.y;
    plane.y = AIRPORT_RUNWAY_WORLD_Y + sample.y;
    plane.z = sample.z;
    plane.yaw = yaw;
    plane.pitch = pitch * 0.35;
    plane.velocityX = delta > 0 ? dx / delta : 0;
    plane.velocityY = delta > 0 ? dy / delta : 0;
    plane.velocityZ = delta > 0 ? dz / delta : 0;
    plane.onGround = sample.y <= runwayBaseY + 1.62;

    if (
      plane.state === "departing" &&
      airportDepartureInProgress === plane &&
      !plane.departureAirborneReleased &&
      sample.y - runwayBaseY >= AIRPORT_AI_TAKEOFF_AIRBORNE_ALTITUDE
    ) {
      airportDepartureInProgress = null;
      plane.departureAirborneReleased = true;
    }

    if (
      plane.state === "approach" &&
      sample.z >= thresholdSouth - 8 &&
      sample.z <= thresholdSouth + 6 &&
      sample.y <= runwayBaseY + 2.8
    ) {
      if (!airportDepartureInProgress) {
        airportDepartureInProgress = plane;
        plane.departureAirborneReleased = true;
      }
      plane.state = "taxiToPark";
      plane.taxiAxis = "x";
      plane.holdRemaining = 0;
      plane.yaw = plane.parkingYaw;
      plane.pitch = 0;
      plane.wasOnRunway = false;
    }
  }
}

function moveAirportPlaneAxisAligned(plane, targetX, targetY, targetZ, speed, dt, axis) {
  const dx = targetX - plane.x;
  const dy = targetY - plane.y;
  const dz = targetZ - plane.z;
  const moveX = axis === "x" ? dx : 0;
  const moveY = dy;
  const moveZ = axis === "z" ? dz : 0;
  const distance = Math.hypot(moveX, moveY, moveZ);
  if (distance <= 0.22) {
    plane.x = axis === "x" ? targetX : plane.x;
    plane.y = targetY;
    plane.z = axis === "z" ? targetZ : plane.z;
    plane.velocityX = 0;
    plane.velocityY = 0;
    plane.velocityZ = 0;
    return true;
  }

  const move = Math.max(0, speed * dt);
  if (move <= 0) {
    return false;
  }
  const step = Math.min(move, distance);
  const invDistance = 1 / Math.max(distance, 0.0001);
  const stepX = moveX * invDistance * step;
  const stepY = moveY * invDistance * step;
  const stepZ = moveZ * invDistance * step;
  plane.x += stepX;
  plane.y += stepY;
  plane.z += stepZ;
  plane.velocityX = dt > 0 ? stepX / dt : 0;
  plane.velocityY = dt > 0 ? stepY / dt : 0;
  plane.velocityZ = dt > 0 ? stepZ / dt : 0;
  plane.yaw = Math.atan2(moveX, moveZ);
  return false;
}

function moveAirportPlaneTowards(plane, targetX, targetY, targetZ, speed, dt, fixedYaw = null) {
  const dx = targetX - plane.x;
  const dy = targetY - plane.y;
  const dz = targetZ - plane.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance <= 0.22) {
    plane.x = targetX;
    plane.y = targetY;
    plane.z = targetZ;
    plane.velocityX = 0;
    plane.velocityY = 0;
    plane.velocityZ = 0;
    if (fixedYaw !== null) {
      plane.yaw = fixedYaw;
    }
    return true;
  }

  const move = Math.max(0, speed * dt);
  if (move <= 0) {
    return false;
  }
  const step = Math.min(move, distance);
  const invDistance = 1 / Math.max(distance, 0.0001);
  const stepX = dx * invDistance * step;
  const stepY = dy * invDistance * step;
  const stepZ = dz * invDistance * step;
  plane.x += stepX;
  plane.y += stepY;
  plane.z += stepZ;
  plane.velocityX = dt > 0 ? stepX / dt : 0;
  plane.velocityY = dt > 0 ? stepY / dt : 0;
  plane.velocityZ = dt > 0 ? stepZ / dt : 0;
  plane.yaw = fixedYaw ?? Math.atan2(dx, dz);
  return false;
}

function sampleAirportTrafficState(plane, cycle, thresholdNorth, thresholdSouth) {
  const x = AIRPORT_CENTER.x + plane.runwayOffsetX;
  let z = thresholdNorth;
  let altitude = 0;

  if (cycle < 0.28) {
    const t = cycle / 0.28;
    z = lerp(thresholdNorth - plane.approachDistance, thresholdNorth, t);
    altitude = lerp(plane.cruiseAltitude, 1.6, t);
  } else if (cycle < 0.46) {
    const t = (cycle - 0.28) / 0.18;
    z = lerp(thresholdNorth, thresholdSouth - 16, t);
    altitude = 1.6;
  } else if (cycle < 0.56) {
    const t = (cycle - 0.46) / 0.1;
    z = lerp(thresholdSouth - 16, thresholdSouth, t);
    altitude = lerp(1.6, 2.4, t);
  } else if (cycle < 0.78) {
    const t = (cycle - 0.56) / 0.22;
    z = lerp(thresholdSouth, thresholdSouth + plane.departureDistance, t);
    altitude = lerp(2.4, plane.cruiseAltitude, t);
  } else {
    const t = (cycle - 0.78) / 0.22;
    z = lerp(thresholdSouth + plane.departureDistance, thresholdNorth - plane.approachDistance, t);
    altitude = lerp(plane.cruiseAltitude, plane.cruiseAltitude - 2, t);
  }

  return { x, y: altitude, z };
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function updateBusMotion(dtSeconds) {
  const bus = SIMULATION_CONFIG.bus;
  if (!bus || !Array.isArray(bus.route) || bus.route.length < 2 || !Number.isFinite(bus.speed)) {
    return;
  }

  if (bus.stopHold > 0) {
    bus.stopHold = Math.max(0, bus.stopHold - dtSeconds);
    bus.isStopped = bus.stopHold > 0;
    return;
  }

  const route = bus.route;
  const segmentCount = route.length - 1;
  let remaining = bus.speed * dtSeconds;
  const maxIterations = route.length * 2;
  let guard = 0;
  while (remaining > 0 && guard < maxIterations) {
    const start = route[bus.segmentIndex];
    const nextSegmentIndex = bus.segmentIndex + 1;
    const end = route[nextSegmentIndex] || route[0];
    const segmentDx = end.x - start.x;
    const segmentDz = end.z - start.z;
    const segmentLength = Math.hypot(segmentDx, segmentDz);

    if (segmentLength <= 0.001) {
      bus.segmentIndex = (bus.segmentIndex + 1) % segmentCount;
      bus.segmentProgress = 0;
      guard += 1;
      continue;
    }

    const remainingInSegment = segmentLength - bus.segmentProgress;
    const arrivalIndex = nextSegmentIndex < route.length ? nextSegmentIndex : 0;
    const arrivalStop = route[arrivalIndex] && route[arrivalIndex].stop;

    if (remaining >= remainingInSegment) {
      remaining -= remainingInSegment;
      bus.segmentIndex = nextSegmentIndex < segmentCount ? nextSegmentIndex : 0;
      bus.segmentProgress = 0;

      if (arrivalStop && arrivalStop.duration > 0) {
        const arrival = route[arrivalIndex];
        bus.stopHold = arrivalStop.duration;
        bus.stopYaw = Math.PI - Math.atan2(segmentDx, segmentDz);
        bus.x = arrival.x;
        bus.z = arrival.z;
        bus.yaw = bus.stopYaw;
        bus.isStopped = true;
        return;
      }

      continue;
    }

    bus.segmentProgress += remaining;
    break;
  }

  const activeStart = route[bus.segmentIndex];
  const activeEnd = route[bus.segmentIndex + 1] || route[0];
  const segmentDx = activeEnd.x - activeStart.x;
  const segmentDz = activeEnd.z - activeStart.z;
  const segmentLength = Math.hypot(segmentDx, segmentDz) || 1;
  const t = bus.segmentProgress / segmentLength;
  bus.x = activeStart.x + segmentDx * t;
  bus.z = activeStart.z + segmentDz * t;
  bus.yaw = Math.PI - Math.atan2(segmentDx, segmentDz);
  bus.isStopped = false;
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
  const brake = (buttonsBitmask & INPUT_BUTTON_BRAKE) !== 0;

  return {
    moveX: right - left,
    moveZ: forward - backward,
    yaw: typeof message.yaw === "number" ? message.yaw : 0,
    pitch: typeof message.pitch === "number" ? message.pitch : 0,
    jumpRequested: (buttonsBitmask & INPUT_BUTTON_JUMP) !== 0,
    brake,
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
  const defaultPath = path.resolve(scriptDir, "../../../../.ip");
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
