import * as THREE from "three";

const WORLD_SIZE = 500;
const TERRAIN_SEGMENTS = 220;
const PLAYER_HEIGHT = 1.55;
const RC_PLANE_MIN_ALTITUDE = 1.2;
const RC_PLANE_MAX_ALTITUDE = 28;
const RC_PLANE_MIN_SPEED = 8;
const RC_PLANE_MAX_SPEED = 26;
const AVATAR_BALL_RADIUS = 0.75;
const AVATAR_LABEL_Y = 1.15;
const GROUND_CONTACT_VISUAL_BIAS = 0.03;
const LABEL_PIXELS_TO_WORLD_X = 1.9 / 384;
const LABEL_PIXELS_TO_WORLD_Y = 0.48 / 96;
const AVATAR_PATTERNS = new Set(["stripes", "checker"]);
const DEFAULT_AVATAR_COLOR = "#3c74d4";
const DEFAULT_AVATAR_PATTERN = "stripes";
const MAX_PITCH = THREE.MathUtils.degToRad(75);
const FACE_PITCH_UP_BIAS = THREE.MathUtils.degToRad(4);
const LOOK_AHEAD_DISTANCE = 16.0;
const INPUT_SEND_HZ = 20;
const INPUT_SEND_DT = 1 / INPUT_SEND_HZ;
const INTERPOLATION_BACK_TICKS = 2;
const INPUT_BUTTON_JUMP = 1 << 0;
const INPUT_BUTTON_FORWARD = 1 << 1;
const INPUT_BUTTON_BACKWARD = 1 << 2;
const INPUT_BUTTON_LEFT = 1 << 3;
const INPUT_BUTTON_RIGHT = 1 << 4;
const DEBUG_NET = new URLSearchParams(window.location.search).get("debugNet") === "1";
const WS_PORT = parsePort(import.meta.env.VITE_WS_PORT, 9003);
const AIRPORT_CENTER = { x: 122, z: -88 };
const AIRPORT_RUNWAY_LENGTH = 118;
const AIRPORT_RUNWAY_WIDTH = 24;
const AIRPORT_FLATTEN_RADIUS_X = 76;
const AIRPORT_FLATTEN_RADIUS_Z = 48;
const MODEL_AIRFIELD_CENTER = { x: -176, z: 92 };
const MODEL_AIRFIELD_RUNWAY_LENGTH = 54;
const MODEL_AIRFIELD_RUNWAY_WIDTH = 10;
const MODEL_AIRFIELD_FLATTEN_RADIUS_X = 40;
const MODEL_AIRFIELD_FLATTEN_RADIUS_Z = 28;
const RAILWAY_Z = 156;
const RAILWAY_Y = 8.2;
const RAILWAY_STATION_X = -34;
const CITY_CENTER = { x: -108, z: -42 };
const FOREST_CENTER = { x: 102, z: 118 };
const PARKED_PLANE_POSITION = { x: 122, z: -88 };
const PARKED_CAR_POSITION = { x: 8, z: 6 };
const PARKED_CAR_YAW = Math.PI * 0.35;
const DAY_DURATION_SECONDS = 5 * 60;
const NIGHT_DURATION_SECONDS = 3 * 60;
const DAY_NIGHT_CYCLE_SECONDS = DAY_DURATION_SECONDS + NIGHT_DURATION_SECONDS;
const DAY_SKY_COLOR = new THREE.Color(0x87c9ff);
const NIGHT_SKY_COLOR = new THREE.Color(0x07111d);
const DAY_FOG_COLOR = new THREE.Color(0x87c9ff);
const NIGHT_FOG_COLOR = new THREE.Color(0x09131f);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87c9ff);
scene.fog = new THREE.Fog(0x87c9ff, 80, 420);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const ambient = new THREE.HemisphereLight(0xe8f0ff, 0x344022, 0.62);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
sun.position.set(140, 220, 100);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 150;
sun.shadow.camera.bottom = -150;
scene.add(sun);

const bounce = new THREE.DirectionalLight(0xbfd2ff, 0.28);
bounce.position.set(-120, 80, -130);
scene.add(bounce);

const terrainGeometry = new THREE.PlaneGeometry(
  WORLD_SIZE,
  WORLD_SIZE,
  TERRAIN_SEGMENTS,
  TERRAIN_SEGMENTS,
);
terrainGeometry.rotateX(-Math.PI / 2);

const terrainPosition = terrainGeometry.attributes.position;
for (let i = 0; i < terrainPosition.count; i += 1) {
  const x = terrainPosition.getX(i);
  const z = terrainPosition.getZ(i);
  terrainPosition.setY(i, terrainHeight(x, z));
}
terrainGeometry.computeVertexNormals();
const terrainDetailTexture = createTerrainDetailTexture(renderer);
const touchdownSmokeTexture = createTouchdownSmokeTexture();

const terrainMaterial = new THREE.MeshStandardMaterial({
  color: 0x6f8f58,
  map: terrainDetailTexture,
  bumpMap: terrainDetailTexture,
  bumpScale: 0.45,
  roughness: 0.88,
  metalness: 0.02,
});

const terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
terrain.receiveShadow = true;
scene.add(terrain);

const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(900, 32, 16),
  new THREE.MeshBasicMaterial({
    color: 0x94d6ff,
    side: THREE.BackSide,
  }),
);
scene.add(skyDome);

const keys = {
  forward: false,
  backward: false,
  left: false,
  right: false,
};

const player = {
  position: new THREE.Vector3(0, PLAYER_HEIGHT + terrainHeight(0, 0), 0),
  courseYaw: 0,
  pitch: 0,
};

const audio = {
  context: null,
};

const net = {
  socket: null,
  connected: false,
  connecting: false,
  nickname: "pilot",
  avatarColor: DEFAULT_AVATAR_COLOR,
  avatarPattern: DEFAULT_AVATAR_PATTERN,
  playerId: null,
  tickRate: INPUT_SEND_HZ,
  interpolationDelayMs: (INTERPOLATION_BACK_TICKS / INPUT_SEND_HZ) * 1000,
  inputSeq: 0,
  inputAccumulator: 0,
  jumpQueued: false,
  playersById: new Map(),
  samplesByPlayerId: new Map(),
  playerAvatarsById: new Map(),
  playerPlanesById: new Map(),
  playerCarsById: new Map(),
  planeTouchdownStateById: new Map(),
  lastAiPlaneCollisionAt: -Infinity,
  latestServerTick: 0,
  lastStateAtMs: 0,
  sentInputs: 0,
  recvStates: 0,
  lastDebugLogAtMs: 0,
  reconnectTimer: null,
  restartExpectedUntilMs: 0,
  reconnectEnabled: false,
};

const cameraTarget = new THREE.Vector3();
const lookDirection = new THREE.Vector3();
const rollDelta = new THREE.Vector3();
const rollAxis = new THREE.Vector3();
const rollQuat = new THREE.Quaternion();
const airportTraffic = [];
const runwayLights = [];
const runwayLightSources = [];
const runwayLightGlows = [];
const runwayApproachLights = [];
const runwayApproachLightSources = [];
const runwayApproachLightGlows = [];
const runwayApproachSpotlights = [];
const railwayTraffic = [];
const activeExplosions = [];
const activeTouchdownSmokes = [];
const parkedPlaneState = {
  mesh: null,
};
const parkedCarState = {
  mesh: null,
};
const rcPlaneState = {
  active: false,
  mesh: null,
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  speed: 0,
  throttleUp: false,
  throttleDown: false,
  wasGrounded: false,
};
const rcControllerState = {
  mesh: null,
};
createAirport();
createParkedCar();
createRailway();
createModelAirfield();
createCity();
createForest();
let dragLookActive = false;
let hasEverCapturedPointer = false;

const help = document.getElementById("help");
const helpTitle = document.getElementById("help-title");
const helpText = document.getElementById("help-text");
const devOverlay = document.getElementById("dev-overlay");
const devOverlayTitle = document.getElementById("dev-overlay-title");
const devOverlayText = document.getElementById("dev-overlay-text");
const nickInput = document.getElementById("nick-input");
const connectButton = document.getElementById("connect-btn");
const colorInput = document.getElementById("color-input");
const patternSelect = document.getElementById("pattern-select");
const avatarPreviewCanvas = document.getElementById("avatar-preview-canvas");
const CLIENT_UPDATE_OVERLAY_DEBOUNCE_MS = 160;

const onKey = (pressed) => (event) => {
  switch (event.code) {
    case "KeyW":
      keys.forward = pressed;
      break;
    case "KeyS":
      keys.backward = pressed;
      break;
    case "KeyA":
      keys.left = pressed;
      break;
    case "KeyD":
      keys.right = pressed;
      break;
    case "Space":
      if (pressed) net.jumpQueued = true;
      break;
    case "KeyL":
      if (pressed) togglePointerLock();
      break;
    case "KeyF":
      if (pressed) togglePlaneBoarding();
      break;
    case "KeyV":
      if (pressed) toggleRcPlane();
      break;
    default:
      break;
  }
};

document.addEventListener("keydown", onKey(true));
document.addEventListener("keyup", onKey(false));

function lockPointer() {
  if (!net.connected) {
    return;
  }
  ensureAudioContext();
  renderer.domElement.requestPointerLock();
}

function unlockPointer() {
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
}

function togglePointerLock() {
  if (document.pointerLockElement === renderer.domElement) {
    unlockPointer();
  } else {
    lockPointer();
  }
}

help.addEventListener("click", lockPointer);
if (connectButton) {
  connectButton.addEventListener("click", startConnectFromUi);
}
if (nickInput) {
  nickInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      startConnectFromUi();
    }
  });
}
if (colorInput) {
  colorInput.addEventListener("input", onAvatarOptionsChanged);
}
if (patternSelect) {
  patternSelect.addEventListener("change", onAvatarOptionsChanged);
}

document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) {
    hasEverCapturedPointer = true;
    document.body.classList.add("playing");
    document.body.classList.remove("mouse-free");
    setHelpStatus("Mouse captured. Press Esc or L to release.", "Playing");
    return;
  }

  document.body.classList.remove("playing");
  if (hasEverCapturedPointer) {
    document.body.classList.add("mouse-free");
    setHelpStatus("Mouse released. Click panel or press L to capture again.", "Mouse Free");
  }
});

document.addEventListener("mousemove", (event) => {
  const pointerLocked = document.pointerLockElement === renderer.domElement;
  if (!pointerLocked && !dragLookActive) return;

  const sensitivity = 0.0022;
  if (rcPlaneState.active) {
    rcPlaneState.yaw += event.movementX * sensitivity;
    rcPlaneState.pitch = Math.max(-MAX_PITCH * 0.85, Math.min(MAX_PITCH * 0.85, rcPlaneState.pitch - event.movementY * sensitivity));
  } else {
    player.courseYaw += event.movementX * sensitivity;
    player.pitch -= event.movementY * sensitivity;
    player.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, player.pitch));
  }
});

renderer.domElement.addEventListener("mousedown", (event) => {
  if (rcPlaneState.active) {
    if (event.button === 0) {
      rcPlaneState.throttleUp = true;
    } else if (event.button === 2) {
      rcPlaneState.throttleDown = true;
    }
    return;
  }
  if (event.button === 0 && document.pointerLockElement !== renderer.domElement) {
    dragLookActive = true;
  }
});

window.addEventListener("mouseup", (event) => {
  if (event.button === 0) {
    rcPlaneState.throttleUp = false;
  } else if (event.button === 2) {
    rcPlaneState.throttleDown = false;
  }
  dragLookActive = false;
});

window.addEventListener("blur", () => {
  keys.forward = false;
  keys.backward = false;
  keys.left = false;
  keys.right = false;
  dragLookActive = false;
  net.jumpQueued = false;
  rcPlaneState.throttleUp = false;
  rcPlaneState.throttleDown = false;
});

window.addEventListener("contextmenu", (event) => {
  if (rcPlaneState.active) {
    event.preventDefault();
  }
});

const clock = new THREE.Clock();
initConnectUi();
initDevNotifications();

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  sendInputTicks(dt);
  syncLocalPlayerFromServer();
  syncRenderedPlayersFromServer();
  updateNetDebug();
  updateAirportTraffic(clock.elapsedTime);
  updateRailwayTraffic(clock.elapsedTime);
  updateExplosions(dt);
  updateTouchdownSmokes(dt);
  updateDayNightCycle(clock.elapsedTime);

  lookDirection.set(
    Math.sin(player.courseYaw) * Math.cos(player.pitch),
    Math.sin(player.pitch),
    -Math.cos(player.courseYaw) * Math.cos(player.pitch),
  );
  const localState = net.playerId ? net.playersById.get(net.playerId) : null;
  const localPlane = net.playerId ? net.playerPlanesById.get(net.playerId) : null;
  const localCar = net.playerId ? net.playerCarsById.get(net.playerId) : null;
  updateRcPlane(dt);
  detectLocalPlaneTrafficCollision(localState, localPlane, clock.elapsedTime);
  updatePlaneWarning(localState);
  if (rcPlaneState.active && rcPlaneState.mesh) {
    camera.position.copy(player.position);
    cameraTarget.copy(rcPlaneState.mesh.position);
    cameraTarget.y += 0.6;
    camera.lookAt(cameraTarget);
  } else if (localState?.inPlane && localPlane) {
    const behindOffset = new THREE.Vector3(-16, 5.2, 0);
    const lookOffset = new THREE.Vector3(20, 1.8, 0);
    behindOffset.applyQuaternion(localPlane.quaternion);
    lookOffset.applyQuaternion(localPlane.quaternion);
    camera.position.copy(localPlane.position).add(behindOffset);
    cameraTarget.copy(localPlane.position).add(lookOffset);
    camera.lookAt(cameraTarget);
  } else if (localState?.inCar && localCar) {
    const behindOffset = new THREE.Vector3(0, 4.2, -10);
    const lookOffset = new THREE.Vector3(0, 1.6, 10);
    behindOffset.applyQuaternion(localCar.quaternion);
    lookOffset.applyQuaternion(localCar.quaternion);
    camera.position.copy(localCar.position).add(behindOffset);
    cameraTarget.copy(localCar.position).add(lookOffset);
    camera.lookAt(cameraTarget);
  } else {
    camera.position.copy(player.position);
    cameraTarget.copy(camera.position).addScaledVector(lookDirection, LOOK_AHEAD_DISTANCE);
    camera.lookAt(cameraTarget);
  }

  renderer.render(scene, camera);
}

animate();

function connectToServer() {
  clearReconnectTimer();
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.hostname || "127.0.0.1";
  const url = `${protocol}://${host}:${WS_PORT}`;

  setHelpStatus(`Connecting as ${net.nickname} to ${url}...`, "Connecting");
  net.connecting = true;
  updateConnectUi();
  const socket = new WebSocket(url);
  net.socket = socket;

  socket.addEventListener("open", () => {
    net.connected = true;
    net.connecting = false;
    net.reconnectEnabled = true;
    net.restartExpectedUntilMs = 0;
    updateConnectUi();
    socket.send(
      JSON.stringify({
        type: "hello",
        name: net.nickname,
        avatar: {
          color: net.avatarColor,
          pattern: net.avatarPattern,
        },
      }),
    );
    hideDevOverlay();
    setHelpStatus("Connected. Click panel or press L to capture mouse.", "Connected");
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    onServerMessage(message);
  });

  socket.addEventListener("close", () => {
    const reconnectExpected = isReconnectExpected();
    net.connected = false;
    net.connecting = false;
    net.playerId = null;
    net.playersById.clear();
    net.samplesByPlayerId.clear();
    for (const playerId of net.playerAvatarsById.keys()) {
      removePlayerAvatar(playerId);
    }
    for (const playerId of net.playerPlanesById.keys()) {
      removePlayerPlane(playerId);
    }
    for (const playerId of net.playerCarsById.keys()) {
      removePlayerCar(playerId);
    }
    document.body.classList.remove("connected");
    document.body.classList.remove("playing");
    updateConnectUi();
    if (reconnectExpected && net.reconnectEnabled) {
      scheduleReconnect(Math.max(250, net.restartExpectedUntilMs - performance.now()));
      setHelpStatus("Reconnecting to server...", "Reconnecting");
      return;
    }
    setHelpStatus("Disconnected from server.", "Disconnected");
  });

  socket.addEventListener("error", () => {
    net.connecting = false;
    updateConnectUi();
    if (!isReconnectExpected()) {
      setHelpStatus(`Connection error. Ensure server is running on port ${WS_PORT}.`, "Connection Error");
    }
  });
}

function onServerMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "welcome") {
    net.playerId = message.playerId;
    if (typeof message.tickRate === "number" && Number.isFinite(message.tickRate) && message.tickRate > 0) {
      net.tickRate = message.tickRate;
      net.interpolationDelayMs = (INTERPOLATION_BACK_TICKS / net.tickRate) * 1000;
    }
    net.playersById.clear();
    net.samplesByPlayerId.clear();
    for (const playerId of net.playerAvatarsById.keys()) {
      removePlayerAvatar(playerId);
    }
    for (const playerId of net.playerPlanesById.keys()) {
      removePlayerPlane(playerId);
    }
    for (const playerId of net.playerCarsById.keys()) {
      removePlayerCar(playerId);
    }

    const snapshotPlayers = Array.isArray(message.snapshot?.players) ? message.snapshot.players : [];
    applyServerPlayerStates(snapshotPlayers, message.snapshot?.tick, { replaceAll: true });
    return;
  }

  if (message.type === "spawn") {
    if (message.state && typeof message.state.playerId === "string") {
      applyServerPlayerStates([message.state], message.tick);
    }
    return;
  }

  if (message.type === "despawn" && typeof message.playerId === "string") {
    net.playersById.delete(message.playerId);
    net.samplesByPlayerId.delete(message.playerId);
    removePlayerAvatar(message.playerId);
    removePlayerPlane(message.playerId);
    removePlayerCar(message.playerId);
    return;
  }

  if (message.type === "snapshot") {
    const nextPlayers = Array.isArray(message.players) ? message.players : [];
    applyServerPlayerStates(nextPlayers, message.tick, { replaceAll: true });
    return;
  }

  if (message.type === "delta") {
    const nextPlayers = Array.isArray(message.players) ? message.players : [];
    applyServerPlayerStates(nextPlayers, message.tick);
    return;
  }

  if (message.type === "state") {
    const nextPlayers = Array.isArray(message.players) ? message.players : [];
    applyServerPlayerStates(nextPlayers, message.tick);
    return;
  }

  if (message.type === "collisions") {
    handleCollisionAudio(message.collisions);
    return;
  }

  if (message.type === "serverRestarting") {
    const delayMs = Number(message.delayMs);
    net.restartExpectedUntilMs = performance.now() + (Number.isFinite(delayMs) ? Math.max(250, delayMs) : 1400);
    return;
  }

  if (message.type === "plane_crashes") {
    handlePlaneCrashes(message.crashes);
  }
}

function applyServerPlayerStates(playerStates, tick, options = {}) {
  const replaceAll = options.replaceAll === true;
  const now = performance.now();

  if (replaceAll) {
    net.playersById.clear();
  }

  for (const state of playerStates) {
    if (!state || typeof state.playerId !== "string") {
      continue;
    }
    net.playersById.set(state.playerId, state);
    pushSample(state.playerId, state, tick, now);
  }

  if (typeof tick === "number" && Number.isFinite(tick)) {
    net.latestServerTick = Math.max(net.latestServerTick, tick);
  }

  if (replaceAll) {
    for (const playerId of net.samplesByPlayerId.keys()) {
      if (!net.playersById.has(playerId)) {
        net.samplesByPlayerId.delete(playerId);
      }
    }
    for (const playerId of net.playerAvatarsById.keys()) {
      if (!net.playersById.has(playerId)) {
        removePlayerAvatar(playerId);
      }
    }
    for (const playerId of net.playerPlanesById.keys()) {
      if (!net.playersById.has(playerId)) {
        removePlayerPlane(playerId);
        net.planeTouchdownStateById.delete(playerId);
      }
    }
    for (const playerId of net.playerCarsById.keys()) {
      if (!net.playersById.has(playerId)) {
        removePlayerCar(playerId);
      }
    }
  }

  net.lastStateAtMs = now;
  net.recvStates += 1;
}

function pushSample(playerId, state, tick, nowMs) {
  const position = state?.position;
  if (!position) {
    return;
  }

  const sample = {
    tick: Number.isFinite(tick) ? tick : net.latestServerTick,
    atMs: nowMs,
    x: Number(position.x) || 0,
    y: Number(position.y) || 0,
    z: Number(position.z) || 0,
  };

  let samples = net.samplesByPlayerId.get(playerId);
  if (!samples) {
    samples = [];
    net.samplesByPlayerId.set(playerId, samples);
  }

  const last = samples[samples.length - 1];
  if (last && last.tick === sample.tick) {
    samples[samples.length - 1] = sample;
  } else {
    samples.push(sample);
  }

  if (samples.length > 40) {
    samples.splice(0, samples.length - 40);
  }
}

function sendInputTicks(frameDt) {
  if (!net.connected || !net.socket || net.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  net.inputAccumulator += frameDt;
  while (net.inputAccumulator >= INPUT_SEND_DT) {
    net.inputAccumulator -= INPUT_SEND_DT;
    const buttonsBitmask = rcPlaneState.active ? 0 : buildButtonsBitmask();
    net.inputSeq += 1;
    net.socket.send(
      JSON.stringify({
        type: "input",
        seq: net.inputSeq,
        buttonsBitmask,
        yaw: rcPlaneState.active ? 0 : player.courseYaw,
        pitch: rcPlaneState.active ? 0 : player.pitch,
      }),
    );
    net.sentInputs += 1;
    net.jumpQueued = false;
  }
}

function buildButtonsBitmask() {
  let mask = 0;
  if (net.jumpQueued) mask |= INPUT_BUTTON_JUMP;
  if (keys.forward) mask |= INPUT_BUTTON_FORWARD;
  if (keys.backward) mask |= INPUT_BUTTON_BACKWARD;
  if (keys.left) mask |= INPUT_BUTTON_LEFT;
  if (keys.right) mask |= INPUT_BUTTON_RIGHT;
  return mask;
}

function syncLocalPlayerFromServer() {
  if (!net.playerId) {
    return;
  }
  const authoritative = net.playersById.get(net.playerId);
  const sample = sampleInterpolatedPosition(net.playerId);
  if (!sample && !authoritative?.position) {
    if (DEBUG_NET && net.connected) {
      const now = performance.now();
      if (net.lastStateAtMs > 0 && now - net.lastStateAtMs > 2000) {
        setHelpStatus("Connected, but no fresh state updates from server (>2s).");
      }
    }
    return;
  }

  const x = sample ? sample.x : Number(authoritative.position.x) || 0;
  const z = sample ? sample.z : Number(authoritative.position.z) || 0;
  const y = sample ? sample.y : Number(authoritative.position.y) || 0;
  const terrainY = terrainBaseForSphereAt(x, z, AVATAR_BALL_RADIUS);
  const worldY = terrainY + Math.max(0, y);
  player.position.set(x, worldY + PLAYER_HEIGHT, z);
  updateParkedPlaneAvailability(authoritative, x, z);
}

function syncRenderedPlayersFromServer() {
  for (const [playerId, state] of net.playersById) {
    if (playerId === net.playerId) {
      if (state?.inPlane) {
        removePlayerCar(playerId);
        const plane = getOrCreatePlayerPlane(playerId, state?.avatar);
        const x = Number(state?.position?.x) || 0;
        const y = Number(state?.position?.y) || 0;
        const z = Number(state?.position?.z) || 0;
        const terrainY = terrainBaseForSphereAt(x, z, AVATAR_BALL_RADIUS);
        plane.position.set(x, terrainY + Math.max(0, y), z);
        plane.rotation.set(0, -(Number(state?.yaw) || 0), 0, "YXZ");
        plane.rotateY(Math.PI / 2);
        plane.rotateZ((Number(state?.pitch) || 0) * 0.35);
        maybeTriggerPlaneTouchdownSmoke(playerId, state);
      } else {
        removePlayerPlane(playerId);
        if (state?.inCar) {
          const car = getOrCreatePlayerCar(playerId, state?.avatar);
          const x = Number(state?.position?.x) || 0;
          const y = Number(state?.position?.y) || 0;
          const z = Number(state?.position?.z) || 0;
          const terrainY = terrainBaseForSphereAt(x, z, AVATAR_BALL_RADIUS);
          car.position.set(x, terrainY + Math.max(0, y) + 0.05, z);
          car.rotation.set(0, -(Number(state?.yaw) || 0), 0, "YXZ");
          car.rotateY(Math.PI);
        } else {
          removePlayerCar(playerId);
        }
      }
      continue;
    }

    if (state?.inPlane) {
      removePlayerAvatar(playerId);
      removePlayerCar(playerId);
      const x = Number(state?.position?.x) || 0;
      const y = Number(state?.position?.y) || 0;
      const z = Number(state?.position?.z) || 0;
      const terrainY = terrainBaseForSphereAt(x, z, AVATAR_BALL_RADIUS);
      const plane = getOrCreatePlayerPlane(playerId, state?.avatar);
      plane.position.set(x, terrainY + Math.max(0, y), z);
      plane.rotation.set(0, -(Number(state?.yaw) || 0), 0, "YXZ");
      plane.rotateY(Math.PI / 2);
      plane.rotateZ((Number(state?.pitch) || 0) * 0.35);
      maybeTriggerPlaneTouchdownSmoke(playerId, state);
      continue;
    }

    if (state?.inCar) {
      removePlayerAvatar(playerId);
      removePlayerPlane(playerId);
      const x = Number(state?.position?.x) || 0;
      const y = Number(state?.position?.y) || 0;
      const z = Number(state?.position?.z) || 0;
      const terrainY = terrainBaseForSphereAt(x, z, AVATAR_BALL_RADIUS);
      const car = getOrCreatePlayerCar(playerId, state?.avatar);
      car.position.set(x, terrainY + Math.max(0, y) + 0.05, z);
      car.rotation.set(0, -(Number(state?.yaw) || 0), 0, "YXZ");
      car.rotateY(Math.PI);
      continue;
    }

    removePlayerPlane(playerId);
    removePlayerCar(playerId);
    const sample = sampleInterpolatedPosition(playerId);
    const position = sample ?? state?.position;
    if (!position) {
      continue;
    }

    const x = Number(position.x) || 0;
    const y = Number(position.y) || 0;
    const z = Number(position.z) || 0;
    const terrainY = terrainBaseForSphereAt(x, z, AVATAR_BALL_RADIUS);
    const worldY = terrainY + Math.max(0, y);
    const avatar = getOrCreatePlayerAvatar(playerId);
    avatar.root.position.set(x, worldY + AVATAR_BALL_RADIUS, z);
    updateAvatarRolling(avatar);
    const yaw = Number(state?.yaw) || 0;
    const pitch = Number(state?.pitch) || 0;
    avatar.face.rotation.set(
      THREE.MathUtils.clamp(pitch, -MAX_PITCH, MAX_PITCH) + FACE_PITCH_UP_BIAS,
      -yaw,
      0,
      "YXZ",
    );
    applyAvatarAppearance(avatar, state?.avatar);
    updateAvatarLabel(avatar, state?.name);
  }
}

function getOrCreatePlayerPlane(playerId, avatar) {
  const existing = net.playerPlanesById.get(playerId);
  if (existing) {
    return existing;
  }

  const plane = createPersonalPlane({
    body: normalizeAvatarColor(avatar?.color),
    accent: 0x1f2f3b,
    scale: 0.44,
  });
  scene.add(plane);
  net.playerPlanesById.set(playerId, plane);
  return plane;
}

function removePlayerPlane(playerId) {
  const plane = net.playerPlanesById.get(playerId);
  if (!plane) {
    return;
  }

  scene.remove(plane);
  plane.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      if (Array.isArray(node.material)) {
        for (const material of node.material) {
          material.dispose();
        }
      } else {
        node.material.dispose();
      }
    }
  });
  net.playerPlanesById.delete(playerId);
  net.planeTouchdownStateById.delete(playerId);
}

function getOrCreatePlayerCar(playerId, avatar) {
  const existing = net.playerCarsById.get(playerId);
  if (existing) {
    return existing;
  }

  const car = createPersonalCar({
    body: normalizeAvatarColor(avatar?.color),
    accent: 0x18232f,
    scale: 0.9,
  });
  scene.add(car);
  net.playerCarsById.set(playerId, car);
  return car;
}

function removePlayerCar(playerId) {
  const car = net.playerCarsById.get(playerId);
  if (!car) {
    return;
  }

  scene.remove(car);
  car.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      if (Array.isArray(node.material)) {
        for (const material of node.material) {
          material.dispose();
        }
      } else {
        node.material.dispose();
      }
    }
  });
  net.playerCarsById.delete(playerId);
}

function updateParkedPlaneAvailability(authoritative, x, z) {
  if (!parkedPlaneState.mesh) {
    return;
  }
  const localInPlane = authoritative?.inPlane === true;
  const localInCar = authoritative?.inCar === true;
  parkedPlaneState.mesh.visible = !localInPlane;
  if (parkedCarState.mesh) {
    parkedCarState.mesh.visible = !localInCar;
  }

  if (!localInPlane && !localInCar) {
    const planeDistance = Math.hypot(x - PARKED_PLANE_POSITION.x, z - PARKED_PLANE_POSITION.z);
    const carDistance = Math.hypot(x - PARKED_CAR_POSITION.x, z - PARKED_CAR_POSITION.z);
    if (carDistance <= 12 && carDistance < planeDistance) {
      setHelpStatus("Press F to board the car and drive.", "Car Ready");
    } else if (planeDistance <= 18) {
      setHelpStatus("Press F to board the plane on the airport and fly.", "Aircraft Ready");
    }
  }
}

function updatePlaneWarning(localState) {
  if (!localState?.inPlane) {
    return;
  }

  if (shouldShowPullUpWarning(localState)) {
    setHelpStatus("Terrain ahead. Climb or align with the runway.", "PULL UP");
  }
}

function shouldShowPullUpWarning(localState) {
  const position = localState?.position;
  const velocity = localState?.velocity;
  if (!position || !velocity) {
    return false;
  }

  const currentX = Number(position.x) || 0;
  const currentZ = Number(position.z) || 0;
  const currentAltitude = Number(position.y) || 0;
  const vx = Number(velocity.x) || 0;
  const vy = Number(velocity.y) || 0;
  const vz = Number(velocity.z) || 0;
  const horizontalSpeed = Math.hypot(vx, vz);
  if (vy >= -0.35 || horizontalSpeed < 6) {
    return false;
  }

  const currentWorldY = terrainBaseForSphereAt(currentX, currentZ, AVATAR_BALL_RADIUS) + Math.max(0, currentAltitude);
  const lookaheadSeconds = 4.5;
  const stepSeconds = 0.2;

  for (let t = stepSeconds; t <= lookaheadSeconds; t += stepSeconds) {
    const sampleX = currentX + vx * t;
    const sampleZ = currentZ + vz * t;
    const projectedWorldY = currentWorldY + vy * t;
    const terrainY = terrainBaseForSphereAt(sampleX, sampleZ, AVATAR_BALL_RADIUS);
    const clearance = projectedWorldY - terrainY;
    if (clearance > AVATAR_BALL_RADIUS + 0.2) {
      continue;
    }

    return !isPointOnRunway(sampleX, sampleZ);
  }

  return false;
}

function isPointOnRunway(x, z) {
  const halfWidth = AIRPORT_RUNWAY_WIDTH * 0.5;
  const halfLength = AIRPORT_RUNWAY_LENGTH * 0.5;
  return (
    x >= AIRPORT_CENTER.x - halfWidth &&
    x <= AIRPORT_CENTER.x + halfWidth &&
    z >= AIRPORT_CENTER.z - halfLength &&
    z <= AIRPORT_CENTER.z + halfLength
  );
}

function togglePlaneBoarding() {
  if (!net.connected || !net.socket || net.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  net.socket.send(JSON.stringify({ type: "toggle_vehicle" }));
}

function toggleRcPlane() {
  if (rcPlaneState.active) {
    rcPlaneState.active = false;
    rcPlaneState.throttleUp = false;
    rcPlaneState.throttleDown = false;
    rcPlaneState.wasGrounded = false;
    if (rcPlaneState.mesh) {
      rcPlaneState.mesh.visible = false;
    }
    if (rcControllerState.mesh) {
      rcControllerState.mesh.visible = false;
    }
    setHelpStatus("RC plane parked.", "RC Off");
    return;
  }

  if (!rcPlaneState.mesh) {
    rcPlaneState.mesh = createRcPlane();
    scene.add(rcPlaneState.mesh);
  }
  if (!rcControllerState.mesh) {
    rcControllerState.mesh = createRcController();
    camera.add(rcControllerState.mesh);
  }

  const spawnX = MODEL_AIRFIELD_CENTER.x - 2;
  const spawnZ = MODEL_AIRFIELD_CENTER.z + MODEL_AIRFIELD_RUNWAY_LENGTH * 0.3;
  const terrainY = terrainHeight(spawnX, spawnZ);
  rcPlaneState.position.set(spawnX, terrainY + 2.2, spawnZ);
  rcPlaneState.velocity.set(0, 0, 0);
  rcPlaneState.yaw = 0;
  rcPlaneState.pitch = 0.08;
  rcPlaneState.speed = 12;
  rcPlaneState.throttleUp = false;
  rcPlaneState.throttleDown = false;
  rcPlaneState.wasGrounded = false;
  rcPlaneState.mesh.visible = true;
  rcControllerState.mesh.visible = true;
  rcPlaneState.active = true;
  setHelpStatus("RC plane active. Use mouse and WASD. Press V to park it.", "RC Ready");
}

function updateRcPlane(dt) {
  if (!rcPlaneState.active || !rcPlaneState.mesh) {
    return;
  }

  const throttleInput = (rcPlaneState.throttleUp ? 1 : 0) - (rcPlaneState.throttleDown ? 1 : 0);
  const rollInput = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const targetSpeed = THREE.MathUtils.clamp(
    rcPlaneState.speed + throttleInput * 18 * dt,
    RC_PLANE_MIN_SPEED,
    RC_PLANE_MAX_SPEED,
  );
  rcPlaneState.speed = THREE.MathUtils.lerp(rcPlaneState.speed, targetSpeed, Math.min(1, dt * 4));
  rcPlaneState.yaw -= rollInput * (1.45 + rcPlaneState.speed * 0.02) * dt;
  rcPlaneState.pitch = THREE.MathUtils.clamp(rcPlaneState.pitch, -MAX_PITCH * 0.85, MAX_PITCH * 0.85);

  const direction = new THREE.Vector3(
    Math.sin(rcPlaneState.yaw) * Math.cos(rcPlaneState.pitch),
    Math.sin(rcPlaneState.pitch),
    -Math.cos(rcPlaneState.yaw) * Math.cos(rcPlaneState.pitch),
  );
  rcPlaneState.velocity.copy(direction).multiplyScalar(rcPlaneState.speed);
  rcPlaneState.position.addScaledVector(rcPlaneState.velocity, dt);

  const terrainY = terrainHeight(rcPlaneState.position.x, rcPlaneState.position.z);
  rcPlaneState.position.x = THREE.MathUtils.clamp(rcPlaneState.position.x, -WORLD_SIZE * 0.5 + 4, WORLD_SIZE * 0.5 - 4);
  rcPlaneState.position.z = THREE.MathUtils.clamp(rcPlaneState.position.z, -WORLD_SIZE * 0.5 + 4, WORLD_SIZE * 0.5 - 4);
  rcPlaneState.position.y = THREE.MathUtils.clamp(
    rcPlaneState.position.y,
    terrainY + RC_PLANE_MIN_ALTITUDE,
    terrainY + RC_PLANE_MAX_ALTITUDE,
  );
  const grounded = rcPlaneState.position.y <= terrainY + RC_PLANE_MIN_ALTITUDE + 0.02;
  if (grounded && !rcPlaneState.wasGrounded) {
    createTouchdownSmoke(rcPlaneState.position.x, terrainY, rcPlaneState.position.z, rcPlaneState.yaw, 0.35);
  }
  rcPlaneState.wasGrounded = grounded;
  if (grounded) {
    rcPlaneState.pitch = Math.max(0.04, rcPlaneState.pitch);
  }

  rcPlaneState.mesh.position.copy(rcPlaneState.position);
  rcPlaneState.mesh.rotation.set(0, -rcPlaneState.yaw, 0, "YXZ");
  rcPlaneState.mesh.rotateY(Math.PI / 2);
  rcPlaneState.mesh.rotateZ(rcPlaneState.pitch * 0.45 - rollInput * 0.2);
}

function createRcPlane() {
  const plane = createPersonalPlane({
    body: 0xf5f06c,
    accent: 0x1d2430,
    scale: 0.16,
  });
  plane.visible = false;
  return plane;
}

function createRcController() {
  const controller = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.14, 0.22),
    new THREE.MeshStandardMaterial({
      color: 0x1e242c,
      roughness: 0.62,
      metalness: 0.18,
    }),
  );
  controller.add(body);

  for (const x of [-0.08, 0.08]) {
    const stickBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 0.02, 12),
      new THREE.MeshStandardMaterial({
        color: 0x2a323c,
        roughness: 0.5,
        metalness: 0.18,
      }),
    );
    stickBase.position.set(x, 0.075, 0.015);
    controller.add(stickBase);

    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.01, 0.08, 10),
      new THREE.MeshStandardMaterial({
        color: 0xc5ccd6,
        roughness: 0.35,
        metalness: 0.3,
      }),
    );
    stick.position.set(x, 0.11, 0.015);
    controller.add(stick);
  }

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.22, 10),
    new THREE.MeshStandardMaterial({
      color: 0xd7dbe2,
      roughness: 0.28,
      metalness: 0.42,
    }),
  );
  antenna.position.set(0, 0.17, -0.06);
  antenna.rotation.x = 0.28;
  controller.add(antenna);

  controller.position.set(0.34, -0.28, -0.72);
  controller.rotation.set(-0.32, -0.24, 0.08);
  controller.visible = false;
  return controller;
}

function getOrCreatePlayerAvatar(playerId) {
  const existing = net.playerAvatarsById.get(playerId);
  if (existing) {
    return existing;
  }

  const root = new THREE.Group();
  const ball = new THREE.Group();
  root.add(ball);

  const bodyGeometry = new THREE.SphereGeometry(AVATAR_BALL_RADIUS, 28, 22);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.08,
  });
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.castShadow = true;
  ball.add(body);

  const face = new THREE.Group();
  root.add(face);

  const eyeGeometry = new THREE.SphereGeometry(0.1, 16, 14);
  const eyeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf6fbff,
    emissive: 0x93cfff,
    emissiveIntensity: 0.65,
    roughness: 0.18,
    metalness: 0.02,
  });
  const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  leftEye.position.set(-0.23, 0.13, -AVATAR_BALL_RADIUS + 0.03);
  const rightEye = leftEye.clone();
  rightEye.position.x = 0.23;
  face.add(leftEye, rightEye);

  const mouthGeometry = new THREE.BoxGeometry(0.34, 0.07, 0.028);
  const mouthMaterial = new THREE.MeshStandardMaterial({ color: 0xc77b82, roughness: 0.28, metalness: 0.02 });
  const mouth = new THREE.Mesh(mouthGeometry, mouthMaterial);
  mouth.position.set(0, -0.2, -AVATAR_BALL_RADIUS + 0.043);
  mouth.rotation.z = 0.05;
  face.add(mouth);

  const toothGeometry = new THREE.BoxGeometry(0.05, 0.07, 0.025);
  const toothMaterial = new THREE.MeshStandardMaterial({ color: 0xf8fbff, roughness: 0.2, metalness: 0.01 });
  const leftTooth = new THREE.Mesh(toothGeometry, toothMaterial);
  leftTooth.position.set(-0.07, -0.19, -AVATAR_BALL_RADIUS + 0.052);
  leftTooth.rotation.z = 0.1;
  const midTooth = leftTooth.clone();
  midTooth.position.x = 0;
  midTooth.rotation.z = 0;
  const rightTooth = leftTooth.clone();
  rightTooth.position.x = 0.07;
  rightTooth.rotation.z = -0.1;
  face.add(leftTooth, midTooth, rightTooth);

  const browGeometry = new THREE.BoxGeometry(0.2, 0.03, 0.03);
  const browMaterial = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.45, metalness: 0.02 });
  const leftBrow = new THREE.Mesh(browGeometry, browMaterial);
  leftBrow.position.set(-0.23, 0.27, -AVATAR_BALL_RADIUS + 0.045);
  leftBrow.rotation.z = -0.55;
  const rightBrow = leftBrow.clone();
  rightBrow.position.x = 0.23;
  rightBrow.rotation.z = 0.55;
  face.add(leftBrow, rightBrow);

  const label = createAvatarLabelSprite();
  label.position.set(0, AVATAR_LABEL_Y, 0);
  root.add(label);

  scene.add(root);
  const avatar = {
    root,
    ball,
    face,
    bodyMaterial,
    label,
    labelTexture: label.material.map,
    labelCanvas: label.userData.labelCanvas,
    labelCtx: label.userData.labelCtx,
    labelName: "",
    appearanceKey: "",
    bodyPatternTexture: null,
    rollingReady: false,
  };
  net.playerAvatarsById.set(playerId, avatar);
  return avatar;
}

function updateAvatarRolling(avatar) {
  if (!avatar.rollingReady) {
    avatar.rollingReady = true;
    avatar.lastX = avatar.root.position.x;
    avatar.lastZ = avatar.root.position.z;
    return;
  }

  const dx = avatar.root.position.x - avatar.lastX;
  const dz = avatar.root.position.z - avatar.lastZ;
  avatar.lastX = avatar.root.position.x;
  avatar.lastZ = avatar.root.position.z;

  rollDelta.set(dx, 0, dz);
  const distance = rollDelta.length();
  if (distance <= 1e-6) {
    return;
  }

  rollAxis.set(rollDelta.z, 0, -rollDelta.x).normalize();
  const angle = distance / AVATAR_BALL_RADIUS;
  rollQuat.setFromAxisAngle(rollAxis, angle);
  avatar.ball.quaternion.premultiply(rollQuat);
}

function handleCollisionAudio(rawCollisions) {
  if (!Array.isArray(rawCollisions) || rawCollisions.length === 0) {
    return;
  }

  const context = ensureAudioContext();
  if (!context || context.state !== "running") {
    return;
  }

  const listenerX = player.position.x;
  const listenerY = player.position.y;
  const listenerZ = player.position.z;
  const maxDistance = 36;

  for (const collision of rawCollisions) {
    if (!collision || typeof collision !== "object") {
      continue;
    }

    const x = Number(collision.x) || 0;
    const y = Number(collision.y) || 0;
    const z = Number(collision.z) || 0;
    const intensity = Number(collision.intensity) || 0;
    if (intensity <= 0) {
      continue;
    }

    const distance = Math.hypot(x - listenerX, y - listenerY, z - listenerZ);
    if (distance > maxDistance) {
      continue;
    }

    const distanceGain = THREE.MathUtils.clamp(1 - distance / maxDistance, 0, 1);
    const gain = THREE.MathUtils.clamp(distanceGain * distanceGain * (0.08 + intensity * 0.065), 0, 0.42);
    if (gain <= 0.001) {
      continue;
    }

    playCollisionClick(context, gain, intensity);
  }
}

function handlePlaneCrashes(rawCrashes) {
  if (!Array.isArray(rawCrashes)) {
    return;
  }

  for (const crash of rawCrashes) {
    if (!crash || typeof crash !== "object") {
      continue;
    }
    spawnExplosion(
      Number(crash.x) || 0,
      Number(crash.y) || 0,
      Number(crash.z) || 0,
    );
  }
}

function spawnExplosion(x, y, z) {
  const root = new THREE.Group();

  for (let i = 0; i < 8; i += 1) {
    const ember = new THREE.Mesh(
      new THREE.SphereGeometry(0.6 + (i % 3) * 0.22, 10, 8),
      new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xffa23c : 0xff5b2e,
        transparent: true,
        opacity: 0.95,
      }),
    );
    ember.position.set(
      (Math.random() - 0.5) * 2.8,
      Math.random() * 1.4,
      (Math.random() - 0.5) * 2.8,
    );
    root.add(ember);
  }

  root.position.set(x, y + 1.5, z);
  scene.add(root);
  activeExplosions.push({
    root,
    age: 0,
    duration: 1.1,
  });
}

function updateExplosions(dt) {
  for (let i = activeExplosions.length - 1; i >= 0; i -= 1) {
    const explosion = activeExplosions[i];
    explosion.age += dt;
    const t = explosion.age / explosion.duration;
    if (t >= 1) {
      scene.remove(explosion.root);
      explosion.root.traverse((node) => {
        if (node.geometry) {
          node.geometry.dispose();
        }
        if (node.material) {
          node.material.dispose();
        }
      });
      activeExplosions.splice(i, 1);
      continue;
    }

    explosion.root.scale.setScalar(1 + t * 4.2);
    explosion.root.position.y += dt * 4.8;
    for (const child of explosion.root.children) {
      if (child.material) {
        child.material.opacity = Math.max(0, 1 - t * 1.2);
      }
    }
  }
}

function createTouchdownSmoke(x, y, z, yaw, intensity = 1) {
  const root = new THREE.Group();
  const forwardX = Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);
  const wheelOffsets = [
    { back: -2.1, side: -1.6 },
    { back: -2.1, side: 1.6 },
  ];

  for (const wheel of wheelOffsets) {
    const baseX = x + forwardX * wheel.back + rightX * wheel.side;
    const baseZ = z + forwardZ * wheel.back + rightZ * wheel.side;
    for (let i = 0; i < 5; i += 1) {
      const smoke = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: touchdownSmokeTexture,
          transparent: true,
          depthWrite: false,
          opacity: 0.72,
          color: i % 2 === 0 ? 0xd9dde2 : 0xb9c0c8,
        }),
      );
      smoke.position.set(
        baseX + (Math.random() - 0.5) * 0.45,
        y + 0.18 + Math.random() * 0.22,
        baseZ + (Math.random() - 0.5) * 0.45,
      );
      const scale = (0.8 + Math.random() * 0.6) * intensity;
      smoke.scale.setScalar(scale);
      smoke.userData.velocity = new THREE.Vector3(
        rightX * wheel.side * 0.14 + (Math.random() - 0.5) * 0.8,
        0.8 + Math.random() * 0.9,
        rightZ * wheel.side * 0.14 + (Math.random() - 0.5) * 0.8,
      );
      root.add(smoke);
    }
  }

  scene.add(root);
  activeTouchdownSmokes.push({
    root,
    age: 0,
    duration: 0.95,
  });
}

function updateTouchdownSmokes(dt) {
  for (let i = activeTouchdownSmokes.length - 1; i >= 0; i -= 1) {
    const smoke = activeTouchdownSmokes[i];
    smoke.age += dt;
    const t = smoke.age / smoke.duration;
    if (t >= 1) {
      scene.remove(smoke.root);
      smoke.root.traverse((node) => {
        if (node.material) {
          node.material.dispose();
        }
      });
      activeTouchdownSmokes.splice(i, 1);
      continue;
    }

    for (const child of smoke.root.children) {
      const velocity = child.userData.velocity;
      if (velocity) {
        child.position.addScaledVector(velocity, dt);
      }
      child.scale.multiplyScalar(1 + dt * 1.9);
      if (child.material) {
        child.material.opacity = Math.max(0, 0.78 - t * 0.95);
      }
    }
  }
}

function maybeTriggerPlaneTouchdownSmoke(playerId, state) {
  const onRunway = state?.inPlane && state?.onGround && isPointOnRunway(
    Number(state?.position?.x) || 0,
    Number(state?.position?.z) || 0,
  );
  const wasOnRunway = net.planeTouchdownStateById.get(playerId) === true;
  if (onRunway && !wasOnRunway) {
    createTouchdownSmoke(
      Number(state?.position?.x) || 0,
      airportBaseTerrainHeight(),
      Number(state?.position?.z) || 0,
      Number(state?.yaw) || 0,
      1,
    );
  }
  net.planeTouchdownStateById.set(playerId, onRunway);
}

function detectLocalPlaneTrafficCollision(localState, localPlane, elapsedTime) {
  if (!localState?.inPlane || !localPlane) {
    return;
  }
  if (elapsedTime - net.lastAiPlaneCollisionAt < 1.5) {
    return;
  }

  for (const trafficPlane of airportTraffic) {
    if (trafficPlane.hiddenUntil && elapsedTime < trafficPlane.hiddenUntil) {
      continue;
    }
    const distance = localPlane.position.distanceTo(trafficPlane.mesh.position);
    if (distance > 5.8) {
      continue;
    }

    spawnExplosion(localPlane.position.x, localPlane.position.y, localPlane.position.z);
    spawnExplosion(
      trafficPlane.mesh.position.x,
      trafficPlane.mesh.position.y,
      trafficPlane.mesh.position.z,
    );
    trafficPlane.hiddenUntil = elapsedTime + 6;
    trafficPlane.wasOnRunway = false;
    trafficPlane.mesh.visible = false;
    net.lastAiPlaneCollisionAt = elapsedTime;
    if (net.socket && net.socket.readyState === WebSocket.OPEN) {
      net.socket.send(JSON.stringify({ type: "report_plane_collision" }));
    }
    break;
  }
}

function ensureAudioContext() {
  if (!audio.context) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      return null;
    }
    audio.context = new AudioCtx();
  }

  if (audio.context.state === "suspended") {
    audio.context.resume().catch(() => {});
  }

  return audio.context;
}

function playCollisionClick(context, gainAmount, intensity) {
  const now = context.currentTime;
  const duration = 0.055;
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const highpass = context.createBiquadFilter();
  const pitch = 220 + Math.min(420, intensity * 120);

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(pitch, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(90, pitch * 0.58), now + duration);

  highpass.type = "highpass";
  highpass.frequency.setValueAtTime(110, now);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.exponentialRampToValueAtTime(gainAmount, now + 0.006);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(highpass);
  highpass.connect(gainNode);
  gainNode.connect(context.destination);

  oscillator.start(now);
  oscillator.stop(now + duration + 0.01);
}

function applyAvatarAppearance(avatar, rawAvatarStyle) {
  const colorHex = normalizeAvatarColor(rawAvatarStyle?.color);
  const pattern = sanitizeAvatarPattern(rawAvatarStyle?.pattern);
  const key = `${colorHex}|${pattern}`;
  if (avatar.appearanceKey === key) {
    return;
  }
  avatar.appearanceKey = key;

  if (avatar.bodyPatternTexture) {
    avatar.bodyPatternTexture.dispose();
    avatar.bodyPatternTexture = null;
  }

  const texture = createAvatarBodyTexture(colorHex, pattern);
  avatar.bodyPatternTexture = texture;
  avatar.bodyMaterial.color.set(0xffffff);
  avatar.bodyMaterial.map = texture;
  avatar.bodyMaterial.needsUpdate = true;
}

function createAvatarBodyTexture(colorHex, pattern) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  const base = new THREE.Color(colorHex);
  const dark = base.clone().multiplyScalar(0.42);
  const light = base.clone().lerp(new THREE.Color(0xffffff), 0.16);
  ctx.fillStyle = `#${base.getHexString()}`;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = `#${dark.getHexString()}`;
  if (pattern === "stripes") {
    const stripe = 14;
    for (let x = 0; x < size; x += stripe * 2) {
      ctx.fillRect(x, 0, stripe, size);
    }
    ctx.fillStyle = `#${light.getHexString()}`;
    for (let x = stripe; x < size; x += stripe * 2) {
      ctx.fillRect(x, 0, Math.max(2, Math.floor(stripe * 0.24)), size);
    }
  } else if (pattern === "checker") {
    const cell = 14;
    for (let y = 0; y < size; y += cell) {
      for (let x = 0; x < size; x += cell) {
        if (((x / cell) + (y / cell)) % 2 === 0) {
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }
    ctx.strokeStyle = `#${light.getHexString()}`;
    ctx.lineWidth = 1;
    for (let n = 0; n <= size; n += cell) {
      ctx.beginPath();
      ctx.moveTo(n, 0);
      ctx.lineTo(n, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, n);
      ctx.lineTo(size, n);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.4, 1.4);
  return texture;
}

function updateAvatarLabel(avatar, rawName) {
  const safeName = sanitizeNickname(rawName);
  if (avatar.labelName === safeName) {
    return;
  }
  avatar.labelName = safeName;

  const ctx = avatar.labelCtx;
  const canvas = avatar.labelCanvas;
  if (!ctx || !canvas) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "bold 60px Segoe UI";
  const textWidth = ctx.measureText(safeName).width;
  const boxWidth = Math.max(120, Math.min(canvas.width - 8, Math.ceil(textWidth + 40)));
  const boxHeight = 92;
  const boxX = Math.floor((canvas.width - boxWidth) * 0.5);
  const boxY = Math.floor((canvas.height - boxHeight) * 0.5);

  drawRoundRect(ctx, boxX, boxY, boxWidth, boxHeight, 14);
  ctx.fillStyle = "rgba(7, 12, 20, 0.72)";
  ctx.fill();
  ctx.strokeStyle = "rgba(210, 232, 255, 0.7)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#f3f8ff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(safeName, canvas.width / 2, canvas.height / 2);
  avatar.label.scale.set(boxWidth * LABEL_PIXELS_TO_WORLD_X, boxHeight * LABEL_PIXELS_TO_WORLD_Y, 1);
  avatar.labelTexture.needsUpdate = true;
}

function createAvatarLabelSprite() {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.9, 0.48, 1);
  sprite.renderOrder = 3;
  sprite.userData.labelCanvas = canvas;
  sprite.userData.labelCtx = ctx;
  return sprite;
}

function removePlayerAvatar(playerId) {
  const avatar = net.playerAvatarsById.get(playerId);
  if (!avatar) {
    return;
  }

  scene.remove(avatar.root);
  avatar.root.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      if (Array.isArray(node.material)) {
        for (const material of node.material) {
          if (material.map) {
            material.map.dispose();
          }
          material.dispose();
        }
      } else {
        if (node.material.map) {
          node.material.map.dispose();
        }
        node.material.dispose();
      }
    }
  });
  if (avatar.labelTexture) {
    avatar.labelTexture.dispose();
  }
  net.playerAvatarsById.delete(playerId);
}

function sampleInterpolatedPosition(playerId) {
  const samples = net.samplesByPlayerId.get(playerId);
  if (!samples || samples.length < 2) {
    return null;
  }

  const renderAtMs = performance.now() - net.interpolationDelayMs;
  if (renderAtMs <= samples[0].atMs) {
    return samples[0];
  }

  const lastSample = samples[samples.length - 1];
  if (renderAtMs >= lastSample.atMs) {
    return lastSample;
  }

  for (let i = 1; i < samples.length; i += 1) {
    const current = samples[i];
    if (renderAtMs > current.atMs) {
      continue;
    }
    const previous = samples[i - 1];
    const spanMs = Math.max(1, current.atMs - previous.atMs);
    const alpha = THREE.MathUtils.clamp((renderAtMs - previous.atMs) / spanMs, 0, 1);
    return {
      x: THREE.MathUtils.lerp(previous.x, current.x, alpha),
      y: THREE.MathUtils.lerp(previous.y, current.y, alpha),
      z: THREE.MathUtils.lerp(previous.z, current.z, alpha),
    };
  }

  return lastSample;
}

function setHelpStatus(text, title = "Click to Play") {
  const nextText = text;
  const nextTitle = title;

  if (helpTitle) {
    helpTitle.textContent = nextTitle;
  }
  if (helpText) {
    helpText.textContent = nextText;
  }
}

function initConnectUi() {
  const savedNickname = window.localStorage.getItem("hra.nickname");
  const savedAvatarColor = window.localStorage.getItem("hra.avatarColor");
  const savedAvatarPattern = window.localStorage.getItem("hra.avatarPattern");
  if (typeof savedNickname === "string" && savedNickname.trim() !== "") {
    net.nickname = sanitizeNickname(savedNickname);
  }
  if (typeof savedAvatarColor === "string") {
    net.avatarColor = normalizeAvatarColor(savedAvatarColor);
  }
  if (typeof savedAvatarPattern === "string") {
    net.avatarPattern = sanitizeAvatarPattern(savedAvatarPattern);
  }
  if (nickInput) {
    nickInput.value = net.nickname;
  }
  if (colorInput) {
    colorInput.value = net.avatarColor;
  }
  if (patternSelect) {
    patternSelect.value = net.avatarPattern;
  }
  renderAvatarPreview(net.avatarColor, net.avatarPattern);
  updateConnectUi();
  setHelpStatus("Enter nickname and connect. Then click panel or press L to capture mouse.", "Ready");
}

function startConnectFromUi() {
  if (net.connected || net.connecting) {
    return;
  }
  net.reconnectEnabled = true;
  ensureAudioContext();
  net.nickname = sanitizeNickname(nickInput?.value);
  net.avatarColor = normalizeAvatarColor(colorInput?.value);
  net.avatarPattern = sanitizeAvatarPattern(patternSelect?.value);
  renderAvatarPreview(net.avatarColor, net.avatarPattern);
  if (nickInput) {
    nickInput.value = net.nickname;
  }
  if (colorInput) {
    colorInput.value = net.avatarColor;
  }
  if (patternSelect) {
    patternSelect.value = net.avatarPattern;
  }
  window.localStorage.setItem("hra.nickname", net.nickname);
  window.localStorage.setItem("hra.avatarColor", net.avatarColor);
  window.localStorage.setItem("hra.avatarPattern", net.avatarPattern);
  connectToServer();
}

function initDevNotifications() {
  if (!import.meta.hot) {
    return;
  }
}

function showDevOverlay(title, text) {
  unlockPointer();
  if (devOverlayTitle) {
    devOverlayTitle.textContent = title;
  }
  if (devOverlayText) {
    devOverlayText.textContent = text;
  }
  if (devOverlay) {
    devOverlay.hidden = false;
  }
}

function hideDevOverlay() {
  if (devOverlay) {
    devOverlay.hidden = true;
  }
}

function scheduleReconnect(delayMs) {
  if (!net.reconnectEnabled) {
    return;
  }

  clearReconnectTimer();
  net.reconnectTimer = window.setTimeout(() => {
    net.reconnectTimer = null;
    if (!net.connected && !net.connecting) {
      connectToServer();
    }
  }, delayMs);
}

function clearReconnectTimer() {
  if (net.reconnectTimer !== null) {
    window.clearTimeout(net.reconnectTimer);
    net.reconnectTimer = null;
  }
}

function isReconnectExpected() {
  return net.restartExpectedUntilMs > performance.now();
}

function onAvatarOptionsChanged() {
  const color = normalizeAvatarColor(colorInput?.value);
  const pattern = sanitizeAvatarPattern(patternSelect?.value);
  renderAvatarPreview(color, pattern);
}

function renderAvatarPreview(colorHex, pattern) {
  if (!(avatarPreviewCanvas instanceof HTMLCanvasElement)) {
    return;
  }

  const ctx = avatarPreviewCanvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const size = avatarPreviewCanvas.width;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.5, size * 0.5 - 1, 0, Math.PI * 2);
  ctx.clip();

  const base = new THREE.Color(colorHex);
  const dark = base.clone().multiplyScalar(0.42);
  const light = base.clone().lerp(new THREE.Color(0xffffff), 0.16);

  ctx.fillStyle = `#${base.getHexString()}`;
  ctx.fillRect(0, 0, size, size);

  if (pattern === "stripes") {
    const stripe = 10;
    ctx.fillStyle = `#${dark.getHexString()}`;
    for (let x = 0; x < size; x += stripe * 2) {
      ctx.fillRect(x, 0, stripe, size);
    }
    ctx.fillStyle = `#${light.getHexString()}`;
    for (let x = stripe; x < size; x += stripe * 2) {
      ctx.fillRect(x, 0, 2, size);
    }
  } else if (pattern === "checker") {
    const cell = 9;
    ctx.fillStyle = `#${dark.getHexString()}`;
    for (let y = 0; y < size; y += cell) {
      for (let x = 0; x < size; x += cell) {
        if (((x / cell) + (y / cell)) % 2 === 0) {
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }
  }

  const gloss = ctx.createRadialGradient(size * 0.34, size * 0.28, 2, size * 0.34, size * 0.28, size * 0.46);
  gloss.addColorStop(0, "rgba(255,255,255,0.42)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, size, size);

  ctx.restore();
}

function updateConnectUi() {
  document.body.classList.toggle("connected", net.connected);
  const disabled = net.connected || net.connecting;
  if (nickInput) {
    nickInput.disabled = disabled;
  }
  if (colorInput) {
    colorInput.disabled = disabled;
  }
  if (patternSelect) {
    patternSelect.disabled = disabled;
  }
  if (connectButton) {
    connectButton.disabled = disabled;
    connectButton.textContent = net.connecting ? "Connecting..." : "Connect";
  }
}

function updateNetDebug() {
  if (!DEBUG_NET) {
    return;
  }

  const now = performance.now();
  if (now - net.lastDebugLogAtMs < 1000) {
    return;
  }
  net.lastDebugLogAtMs = now;

  const stateAgeMs = net.lastStateAtMs > 0 ? Math.round(now - net.lastStateAtMs) : -1;
  console.debug(
    "[client][net]",
    `connected=${net.connected}`,
    `inputsSent=${net.sentInputs}`,
    `statesRecv=${net.recvStates}`,
    `stateAgeMs=${stateAgeMs}`,
  );
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function terrainHeight(x, z) {
  const airportOverride = airportTerrainOverride(x, z);
  if (airportOverride !== null) {
    return airportOverride;
  }
  const modelAirfieldOverride = modelAirfieldTerrainOverride(x, z);
  if (modelAirfieldOverride !== null) {
    return modelAirfieldOverride;
  }

  const distanceFromCenter = Math.hypot(x, z);
  const centerRadius = WORLD_SIZE * 0.2;
  const transition = WORLD_SIZE * 0.25;
  const t = THREE.MathUtils.clamp((distanceFromCenter - centerRadius) / transition, 0, 1);
  const roughness = smoothstep(t);

  const mountains = fbm(x * 0.01, z * 0.01, 4, 2.0, 0.5) * (6.0 + roughness * 11.0);
  const hills = fbm(x * 0.03, z * 0.03, 3, 2.1, 0.55) * (2.8 + roughness * 3.4);
  const ripples = fbm(x * 0.085, z * 0.085, 2, 2.0, 0.5) * 0.9;

  return mountains + hills + ripples;
}

function airportTerrainOverride(x, z) {
  const dx = x - AIRPORT_CENTER.x;
  const dz = z - AIRPORT_CENTER.z;
  const nx = Math.abs(dx) / AIRPORT_FLATTEN_RADIUS_X;
  const nz = Math.abs(dz) / AIRPORT_FLATTEN_RADIUS_Z;
  const envelope = Math.max(nx, nz);
  if (envelope >= 1.2) {
    return null;
  }

  const baseTerrain = airportBaseTerrainHeight();
  const apronWave = Math.sin(dx * 0.08) * 0.05 + Math.cos(dz * 0.06) * 0.05;
  const edgeBlend = THREE.MathUtils.clamp((envelope - 0.82) / 0.38, 0, 1);
  const naturalTerrain = terrainNoiseHeight(x, z);
  return THREE.MathUtils.lerp(baseTerrain + apronWave, naturalTerrain, smoothstep(edgeBlend));
}

function airportBaseTerrainHeight() {
  return terrainNoiseHeight(AIRPORT_CENTER.x, AIRPORT_CENTER.z) + 0.22;
}

function modelAirfieldTerrainOverride(x, z) {
  const dx = x - MODEL_AIRFIELD_CENTER.x;
  const dz = z - MODEL_AIRFIELD_CENTER.z;
  const nx = Math.abs(dx) / MODEL_AIRFIELD_FLATTEN_RADIUS_X;
  const nz = Math.abs(dz) / MODEL_AIRFIELD_FLATTEN_RADIUS_Z;
  const envelope = Math.max(nx, nz);
  if (envelope >= 1.12) {
    return null;
  }

  const baseTerrain = modelAirfieldBaseTerrainHeight();
  const edgeBlend = THREE.MathUtils.clamp((envelope - 0.78) / 0.34, 0, 1);
  const naturalTerrain = terrainNoiseHeight(x, z);
  return THREE.MathUtils.lerp(baseTerrain, naturalTerrain, smoothstep(edgeBlend));
}

function modelAirfieldBaseTerrainHeight() {
  return terrainNoiseHeight(MODEL_AIRFIELD_CENTER.x, MODEL_AIRFIELD_CENTER.z) + 0.12;
}

function terrainNoiseHeight(x, z) {
  const distanceFromCenter = Math.hypot(x, z);
  const centerRadius = WORLD_SIZE * 0.2;
  const transition = WORLD_SIZE * 0.25;
  const t = THREE.MathUtils.clamp((distanceFromCenter - centerRadius) / transition, 0, 1);
  const roughness = smoothstep(t);

  const mountains = fbm(x * 0.01, z * 0.01, 4, 2.0, 0.5) * (6.0 + roughness * 11.0);
  const hills = fbm(x * 0.03, z * 0.03, 3, 2.1, 0.55) * (2.8 + roughness * 3.4);
  const ripples = fbm(x * 0.085, z * 0.085, 2, 2.0, 0.5) * 0.9;

  return mountains + hills + ripples;
}

function createAirport() {
  const airport = new THREE.Group();
  const runwayY = terrainHeight(AIRPORT_CENTER.x, AIRPORT_CENTER.z) + 0.04;
  const apronCenter = { x: AIRPORT_CENTER.x - 30, z: AIRPORT_CENTER.z + 28 };

  const runway = new THREE.Mesh(
    new THREE.BoxGeometry(AIRPORT_RUNWAY_WIDTH, 0.18, AIRPORT_RUNWAY_LENGTH),
    new THREE.MeshStandardMaterial({
      color: 0x2c3138,
      roughness: 0.9,
      metalness: 0.03,
    }),
  );
  runway.position.set(AIRPORT_CENTER.x, runwayY, AIRPORT_CENTER.z);
  runway.receiveShadow = true;
  runway.castShadow = true;
  airport.add(runway);

  const shoulder = new THREE.Mesh(
    new THREE.BoxGeometry(AIRPORT_RUNWAY_WIDTH + 14, 0.08, AIRPORT_RUNWAY_LENGTH + 10),
    new THREE.MeshStandardMaterial({
      color: 0x66705c,
      roughness: 1,
      metalness: 0,
    }),
  );
  shoulder.position.set(AIRPORT_CENTER.x, runwayY - 0.08, AIRPORT_CENTER.z);
  shoulder.receiveShadow = true;
  airport.add(shoulder);

  const stripeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf7f2d8,
    emissive: 0x2b2415,
    emissiveIntensity: 0.15,
    roughness: 0.72,
    metalness: 0.02,
  });

  for (let i = -3; i <= 3; i += 1) {
    if (i === 0) {
      continue;
    }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 9), stripeMaterial);
    stripe.position.set(AIRPORT_CENTER.x, runwayY + 0.12, AIRPORT_CENTER.z + i * 15);
    airport.add(stripe);
  }

  for (const end of [-1, 1]) {
    for (let i = -2; i <= 2; i += 1) {
      const threshold = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 4.6), stripeMaterial);
      threshold.position.set(
        AIRPORT_CENTER.x + i * 3.3,
        runwayY + 0.12,
        AIRPORT_CENTER.z + end * (AIRPORT_RUNWAY_LENGTH * 0.5 - 8),
      );
      airport.add(threshold);
    }
  }

  const terminal = new THREE.Mesh(
    new THREE.BoxGeometry(26, 8.5, 14),
    new THREE.MeshStandardMaterial({
      color: 0xd8ddd7,
      roughness: 0.62,
      metalness: 0.08,
    }),
  );
  terminal.position.set(AIRPORT_CENTER.x - 42, runwayY + 4.25, AIRPORT_CENTER.z + 12);
  terminal.castShadow = true;
  terminal.receiveShadow = true;
  airport.add(terminal);

  const terminalGlass = new THREE.Mesh(
    new THREE.BoxGeometry(20, 3.4, 0.5),
    new THREE.MeshStandardMaterial({
      color: 0x9cc8de,
      emissive: 0x3c6482,
      emissiveIntensity: 0.18,
      roughness: 0.15,
      metalness: 0.55,
    }),
  );
  terminalGlass.position.set(AIRPORT_CENTER.x - 42, runwayY + 5, AIRPORT_CENTER.z + 19.2);
  airport.add(terminalGlass);

  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2, 4.2, 18, 12),
    new THREE.MeshStandardMaterial({
      color: 0xbfc6cb,
      roughness: 0.54,
      metalness: 0.15,
    }),
  );
  tower.position.set(AIRPORT_CENTER.x - 48, runwayY + 9, AIRPORT_CENTER.z - 6);
  tower.castShadow = true;
  tower.receiveShadow = true;
  airport.add(tower);

  const towerCabin = new THREE.Mesh(
    new THREE.CylinderGeometry(5.6, 4.8, 3.6, 12),
    new THREE.MeshStandardMaterial({
      color: 0x6f8ea0,
      emissive: 0x2f4658,
      emissiveIntensity: 0.22,
      roughness: 0.2,
      metalness: 0.65,
    }),
  );
  towerCabin.position.set(AIRPORT_CENTER.x - 48, runwayY + 18.8, AIRPORT_CENTER.z - 6);
  towerCabin.castShadow = true;
  airport.add(towerCabin);

  for (const hangarPos of [
    { x: AIRPORT_CENTER.x + 40, z: AIRPORT_CENTER.z + 36 },
    { x: AIRPORT_CENTER.x + 58, z: AIRPORT_CENTER.z + 36 },
  ]) {
    const hangar = new THREE.Mesh(
      new THREE.BoxGeometry(14, 6.5, 12),
      new THREE.MeshStandardMaterial({
        color: 0xa1a7aa,
        roughness: 0.7,
        metalness: 0.1,
      }),
    );
    hangar.position.set(hangarPos.x, runwayY + 3.25, hangarPos.z);
    hangar.castShadow = true;
    hangar.receiveShadow = true;
    airport.add(hangar);

    const door = new THREE.Mesh(
      new THREE.BoxGeometry(8, 4.5, 0.4),
      new THREE.MeshStandardMaterial({
        color: 0x5d6d79,
        roughness: 0.42,
        metalness: 0.32,
      }),
    );
    door.position.set(hangarPos.x, runwayY + 2.4, hangarPos.z + 6.1);
    airport.add(door);
  }

  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(52, 0.12, 30),
    new THREE.MeshStandardMaterial({
      color: 0x757c80,
      roughness: 0.88,
      metalness: 0.03,
    }),
  );
  apron.position.set(apronCenter.x, runwayY - 0.01, apronCenter.z);
  apron.receiveShadow = true;
  airport.add(apron);

  const taxiway = new THREE.Mesh(
    new THREE.BoxGeometry(16, 0.08, 34),
    new THREE.MeshStandardMaterial({
      color: 0x626a6e,
      roughness: 0.88,
      metalness: 0.03,
    }),
  );
  taxiway.position.set(AIRPORT_CENTER.x - 8, runwayY + 0.01, AIRPORT_CENTER.z + 14);
  taxiway.receiveShadow = true;
  airport.add(taxiway);

  for (const standOffset of [-10, 10]) {
    const standMark = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 3.9, 24),
      stripeMaterial,
    );
    standMark.rotation.x = -Math.PI / 2;
    standMark.position.set(apronCenter.x - 7, runwayY + 0.13, apronCenter.z + standOffset);
    airport.add(standMark);
  }

  for (const planeConfig of [
    {
      runwayOffsetX: -3.2,
      cycleDuration: 40,
      phase: 0.0,
      cruiseAltitude: 34,
      approachDistance: 124,
      departureDistance: 158,
      body: 0xf3f5f7,
      accent: 0x2f6fa3,
    },
    {
      runwayOffsetX: 3.4,
      cycleDuration: 40,
      phase: 0.2,
      cruiseAltitude: 42,
      approachDistance: 142,
      departureDistance: 176,
      body: 0xf6f0ea,
      accent: 0xc96d2c,
    },
    {
      runwayOffsetX: -1.4,
      cycleDuration: 40,
      phase: 0.4,
      cruiseAltitude: 30,
      approachDistance: 116,
      departureDistance: 150,
      body: 0xeceff3,
      accent: 0x2f9a6d,
    },
    {
      runwayOffsetX: 1.6,
      cycleDuration: 40,
      phase: 0.6,
      cruiseAltitude: 38,
      approachDistance: 136,
      departureDistance: 168,
      body: 0xf4f4ef,
      accent: 0xa83d52,
    },
    {
      runwayOffsetX: 0,
      cycleDuration: 40,
      phase: 0.8,
      cruiseAltitude: 46,
      approachDistance: 156,
      departureDistance: 188,
      body: 0xe8edf5,
      accent: 0x7559b7,
    },
  ]) {
    const airliner = createAirliner(planeConfig);
    airport.add(airliner);
    airportTraffic.push({
      mesh: airliner,
      runwayOffsetX: planeConfig.runwayOffsetX,
      cycleDuration: planeConfig.cycleDuration,
      phase: planeConfig.phase,
      cruiseAltitude: planeConfig.cruiseAltitude,
      approachDistance: planeConfig.approachDistance,
      departureDistance: planeConfig.departureDistance,
      turnSide: planeConfig.runwayOffsetX >= 0 ? 1 : -1,
      wasOnRunway: false,
    });
  }

  parkedPlaneState.mesh = createPersonalPlane({
    body: 0xf5f6f8,
    accent: 0x2068a0,
    scale: 0.52,
  });
  parkedPlaneState.mesh.position.set(PARKED_PLANE_POSITION.x, runwayY + 0.1, PARKED_PLANE_POSITION.z);
  parkedPlaneState.mesh.rotation.y = Math.PI * 0.5;
  airport.add(parkedPlaneState.mesh);

  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 12; i += 1) {
      const lightColor = side < 0 ? 0xd54545 : 0x6fc7ff;
      const emissiveColor = side < 0 ? 0xb22020 : 0x3b8fca;
      const light = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.18, 1.2, 8),
        new THREE.MeshStandardMaterial({
          color: lightColor,
          emissive: emissiveColor,
          emissiveIntensity: 0.8,
          roughness: 0.3,
          metalness: 0.05,
        }),
      );
      light.position.set(
        AIRPORT_CENTER.x + side * (AIRPORT_RUNWAY_WIDTH * 0.5 + 1.8),
        runwayY + 0.6,
        AIRPORT_CENTER.z - AIRPORT_RUNWAY_LENGTH * 0.5 + 8 + i * 9.2,
      );
      airport.add(light);
      runwayLights.push(light);

      const glow = new THREE.PointLight(lightColor, 0, 14, 2);
      glow.position.set(light.position.x, light.position.y + 0.45, light.position.z);
      airport.add(glow);
      runwayLightSources.push(glow);

      const glowSprite = createRunwayLightGlow(lightColor);
      glowSprite.position.set(light.position.x, light.position.y + 0.55, light.position.z);
      airport.add(glowSprite);
      runwayLightGlows.push(glowSprite);
    }
  }

  for (const end of [1]) {
    const endZ = AIRPORT_CENTER.z + end * (AIRPORT_RUNWAY_LENGTH * 0.5 + 10);
    for (let row = 0; row < 4; row += 1) {
      const z = endZ + end * row * 7.5;
      const width = 4.5 + row * 2.6;
      for (const offsetX of [-width, 0, width]) {
        const housing = new THREE.Mesh(
          new THREE.BoxGeometry(0.9, 1.4, 0.9),
          new THREE.MeshStandardMaterial({
            color: 0xe7e1c7,
            emissive: 0xcba94d,
            emissiveIntensity: 0.9,
            roughness: 0.25,
            metalness: 0.08,
          }),
        );
        housing.position.set(AIRPORT_CENTER.x + offsetX, runwayY + 0.7, z);
        airport.add(housing);
        runwayApproachLights.push(housing);

        const source = new THREE.PointLight(0xffdf8f, 0, 22, 1.8);
        source.position.set(housing.position.x, housing.position.y + 0.2, housing.position.z);
        airport.add(source);
        runwayApproachLightSources.push(source);

        const target = new THREE.Object3D();
        target.position.set(
          AIRPORT_CENTER.x + offsetX * 0.2,
          runwayY + 0.4,
          z - end * 20,
        );
        airport.add(target);

        const spotlight = new THREE.SpotLight(0xfff1bf, 0, 42, Math.PI / 7, 0.45, 1.2);
        spotlight.position.set(housing.position.x, housing.position.y + 0.2, housing.position.z);
        spotlight.target = target;
        spotlight.castShadow = false;
        airport.add(spotlight);
        runwayApproachSpotlights.push(spotlight);

        const glowSprite = createRunwayLightGlow(0xffdf8f);
        glowSprite.position.set(housing.position.x, housing.position.y + 0.2, housing.position.z);
        glowSprite.scale.setScalar(2.2);
        airport.add(glowSprite);
        runwayApproachLightGlows.push(glowSprite);
      }
    }
  }

  airport.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      if (node.receiveShadow === undefined) {
        node.receiveShadow = true;
      }
    }
  });

  scene.add(airport);
}

function createModelAirfield() {
  const airfield = new THREE.Group();
  const runwayY = terrainHeight(MODEL_AIRFIELD_CENTER.x, MODEL_AIRFIELD_CENTER.z) + 0.03;
  const prepAreaCenter = { x: MODEL_AIRFIELD_CENTER.x - 11, z: MODEL_AIRFIELD_CENTER.z + 12 };

  const grassPad = new THREE.Mesh(
    new THREE.BoxGeometry(MODEL_AIRFIELD_RUNWAY_WIDTH + 18, 0.1, MODEL_AIRFIELD_RUNWAY_LENGTH + 16),
    new THREE.MeshStandardMaterial({
      color: 0x6f8459,
      roughness: 1,
      metalness: 0,
    }),
  );
  grassPad.position.set(MODEL_AIRFIELD_CENTER.x, runwayY - 0.05, MODEL_AIRFIELD_CENTER.z);
  grassPad.receiveShadow = true;
  airfield.add(grassPad);

  const runway = new THREE.Mesh(
    new THREE.BoxGeometry(MODEL_AIRFIELD_RUNWAY_WIDTH, 0.08, MODEL_AIRFIELD_RUNWAY_LENGTH),
    new THREE.MeshStandardMaterial({
      color: 0x31363b,
      roughness: 0.92,
      metalness: 0.02,
    }),
  );
  runway.position.set(MODEL_AIRFIELD_CENTER.x, runwayY, MODEL_AIRFIELD_CENTER.z);
  runway.receiveShadow = true;
  airfield.add(runway);

  const centerStripeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf1edd5,
    roughness: 0.74,
    metalness: 0.02,
  });
  for (let i = -2; i <= 2; i += 1) {
    if (i === 0) {
      continue;
    }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.03, 4.2), centerStripeMaterial);
    stripe.position.set(MODEL_AIRFIELD_CENTER.x, runwayY + 0.055, MODEL_AIRFIELD_CENTER.z + i * 8);
    airfield.add(stripe);
  }

  const prepArea = new THREE.Mesh(
    new THREE.BoxGeometry(16, 0.08, 10),
    new THREE.MeshStandardMaterial({
      color: 0x767d80,
      roughness: 0.88,
      metalness: 0.03,
    }),
  );
  prepArea.position.set(prepAreaCenter.x, runwayY - 0.01, prepAreaCenter.z);
  prepArea.receiveShadow = true;
  airfield.add(prepArea);

  const shelter = new THREE.Mesh(
    new THREE.BoxGeometry(7, 2.8, 3.6),
    new THREE.MeshStandardMaterial({
      color: 0xc7c1b2,
      roughness: 0.68,
      metalness: 0.06,
    }),
  );
  shelter.position.set(prepAreaCenter.x - 1.4, runwayY + 1.4, prepAreaCenter.z - 6.4);
  shelter.castShadow = true;
  shelter.receiveShadow = true;
  airfield.add(shelter);

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(8, 0.18, 4.4),
    new THREE.MeshStandardMaterial({
      color: 0x84443a,
      roughness: 0.55,
      metalness: 0.12,
    }),
  );
  roof.position.set(prepAreaCenter.x - 1.4, runwayY + 2.95, prepAreaCenter.z - 6.4);
  roof.rotation.z = 0.04;
  roof.castShadow = true;
  airfield.add(roof);

  for (const side of [-1, 1]) {
    const windsockPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 3.8, 10),
      new THREE.MeshStandardMaterial({
        color: 0xd3d7dc,
        roughness: 0.34,
        metalness: 0.36,
      }),
    );
    windsockPole.position.set(MODEL_AIRFIELD_CENTER.x + side * 8.5, runwayY + 1.9, MODEL_AIRFIELD_CENTER.z - 20);
    airfield.add(windsockPole);

    const windsock = new THREE.Mesh(
      new THREE.ConeGeometry(0.24, 1.7, 10),
      new THREE.MeshStandardMaterial({
        color: side < 0 ? 0xe05c43 : 0xf0f3f7,
        roughness: 0.58,
        metalness: 0.04,
      }),
    );
    windsock.rotation.z = Math.PI / 2;
    windsock.rotation.y = side < 0 ? Math.PI : 0;
    windsock.position.set(MODEL_AIRFIELD_CENTER.x + side * 8.5, runwayY + 3.25, MODEL_AIRFIELD_CENTER.z - 19.5);
    airfield.add(windsock);
  }

  const parkedRc = createRcPlane();
  parkedRc.visible = true;
  parkedRc.position.set(prepAreaCenter.x + 3.8, runwayY + 0.06, prepAreaCenter.z + 1.4);
  parkedRc.rotation.y = Math.PI * 0.18;
  airfield.add(parkedRc);

  scene.add(airfield);
}

function updateDayNightCycle(elapsedTime) {
  const cycleTime = elapsedTime % DAY_NIGHT_CYCLE_SECONDS;
  const isNight = cycleTime >= DAY_DURATION_SECONDS;
  const phase = isNight
    ? (cycleTime - DAY_DURATION_SECONDS) / NIGHT_DURATION_SECONDS
    : cycleTime / DAY_DURATION_SECONDS;
  const blend = isNight ? smoothstep(phase) : 1 - smoothstep(phase);

  scene.background.copy(DAY_SKY_COLOR).lerp(NIGHT_SKY_COLOR, blend);
  scene.fog.color.copy(DAY_FOG_COLOR).lerp(NIGHT_FOG_COLOR, blend);
  skyDome.material.color.copy(scene.background);
  ambient.intensity = THREE.MathUtils.lerp(0.62, 0.12, blend);
  ambient.color.setRGB(
    THREE.MathUtils.lerp(0.91, 0.16, blend),
    THREE.MathUtils.lerp(0.94, 0.2, blend),
    THREE.MathUtils.lerp(1.0, 0.34, blend),
  );
  ambient.groundColor.setRGB(
    THREE.MathUtils.lerp(0.2, 0.03, blend),
    THREE.MathUtils.lerp(0.25, 0.05, blend),
    THREE.MathUtils.lerp(0.13, 0.08, blend),
  );
  sun.intensity = THREE.MathUtils.lerp(1.1, 0.08, blend);
  bounce.intensity = THREE.MathUtils.lerp(0.28, 0.04, blend);
  terrainMaterial.color.setRGB(
    THREE.MathUtils.lerp(0.44, 0.11, blend),
    THREE.MathUtils.lerp(0.56, 0.16, blend),
    THREE.MathUtils.lerp(0.35, 0.2, blend),
  );

  const nightBlend = isNight ? smoothstep(phase) : 0;
  const runwayGlow = isNight ? THREE.MathUtils.lerp(0.6, 2.8, nightBlend) : 0;
  for (const light of runwayLights) {
    if (!(light.material instanceof THREE.MeshStandardMaterial)) {
      continue;
    }
    light.material.emissiveIntensity = runwayGlow;
  }
  const runwayLightIntensity = isNight ? THREE.MathUtils.lerp(0.0, 4.8, nightBlend) : 0;
  for (const light of runwayLightSources) {
    light.intensity = runwayLightIntensity;
  }
  const runwayGlowOpacity = isNight ? THREE.MathUtils.lerp(0.0, 0.9, nightBlend) : 0;
  const runwayGlowScale = THREE.MathUtils.lerp(1.2, 3.2, nightBlend);
  for (const glow of runwayLightGlows) {
    if (!(glow.material instanceof THREE.SpriteMaterial)) {
      continue;
    }
    glow.material.opacity = runwayGlowOpacity;
    glow.visible = runwayGlowOpacity > 0.01;
    glow.scale.setScalar(runwayGlowScale);
  }

  const approachGlow = isNight ? THREE.MathUtils.lerp(0.8, 3.6, nightBlend) : 0;
  for (const light of runwayApproachLights) {
    if (!(light.material instanceof THREE.MeshStandardMaterial)) {
      continue;
    }
    light.material.emissiveIntensity = approachGlow;
  }
  const approachIntensity = isNight ? THREE.MathUtils.lerp(0.0, 7.5, nightBlend) : 0;
  for (const light of runwayApproachLightSources) {
    light.intensity = approachIntensity;
  }
  const approachSpotlightIntensity = isNight ? THREE.MathUtils.lerp(0.0, 16, nightBlend) : 0;
  for (const light of runwayApproachSpotlights) {
    light.intensity = approachSpotlightIntensity;
  }
  const approachGlowOpacity = isNight ? THREE.MathUtils.lerp(0.0, 1.0, nightBlend) : 0;
  const approachGlowScale = THREE.MathUtils.lerp(2.2, 4.8, nightBlend);
  for (const glow of runwayApproachLightGlows) {
    if (!(glow.material instanceof THREE.SpriteMaterial)) {
      continue;
    }
    glow.material.opacity = approachGlowOpacity;
    glow.visible = approachGlowOpacity > 0.01;
    glow.scale.setScalar(approachGlowScale);
  }
}

function createRunwayLightGlow(color) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.28, `#${new THREE.Color(color).getHexString()}`);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(1.2);
  sprite.visible = false;
  return sprite;
}

function createParkedCar() {
  const car = createPersonalCar({
    body: 0xce3535,
    accent: 0xf4f0d8,
    scale: 0.95,
  });
  const groundY = terrainHeight(PARKED_CAR_POSITION.x, PARKED_CAR_POSITION.z);
  car.position.set(PARKED_CAR_POSITION.x, groundY + 0.05, PARKED_CAR_POSITION.z);
  car.rotation.y = Math.PI - PARKED_CAR_YAW;
  car.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  parkedCarState.mesh = car;
  scene.add(car);
}

function createRailway() {
  const railway = new THREE.Group();
  const startX = -WORLD_SIZE * 0.5 - 18;
  const endX = WORLD_SIZE * 0.5 + 18;
  const trackLength = endX - startX;

  const ballast = new THREE.Mesh(
    new THREE.BoxGeometry(trackLength, 0.7, 9),
    new THREE.MeshStandardMaterial({
      color: 0x7a7770,
      roughness: 0.95,
      metalness: 0.02,
    }),
  );
  ballast.position.set((startX + endX) * 0.5, RAILWAY_Y - 0.55, RAILWAY_Z);
  ballast.receiveShadow = true;
  railway.add(ballast);

  for (let x = startX; x <= endX; x += 8) {
    const sleeper = new THREE.Mesh(
      new THREE.BoxGeometry(4.5, 0.28, 3.2),
      new THREE.MeshStandardMaterial({
        color: 0x604833,
        roughness: 0.92,
        metalness: 0.02,
      }),
    );
    sleeper.position.set(x, RAILWAY_Y - 0.12, RAILWAY_Z);
    sleeper.receiveShadow = true;
    railway.add(sleeper);
  }

  for (const railOffset of [-1.45, 1.45]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(trackLength, 0.18, 0.22),
      new THREE.MeshStandardMaterial({
        color: 0xc1c7cc,
        roughness: 0.34,
        metalness: 0.82,
      }),
    );
    rail.position.set((startX + endX) * 0.5, RAILWAY_Y + 0.12, RAILWAY_Z + railOffset);
    rail.castShadow = true;
    railway.add(rail);
  }

  for (let x = startX + 12; x < endX; x += 18) {
    const supportHeight = Math.max(4, RAILWAY_Y - terrainHeight(x, RAILWAY_Z) - 0.8);
    const support = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, supportHeight, 1.2),
      new THREE.MeshStandardMaterial({
        color: 0x8b908f,
        roughness: 0.86,
        metalness: 0.08,
      }),
    );
    support.position.set(x, RAILWAY_Y - supportHeight * 0.5 - 0.2, RAILWAY_Z);
    support.receiveShadow = true;
    railway.add(support);
  }

  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(40, 0.45, 10),
    new THREE.MeshStandardMaterial({
      color: 0xb8b1a4,
      roughness: 0.88,
      metalness: 0.04,
    }),
  );
  platform.position.set(RAILWAY_STATION_X, RAILWAY_Y - 0.18, RAILWAY_Z - 10);
  platform.receiveShadow = true;
  railway.add(platform);

  const stationBody = new THREE.Mesh(
    new THREE.BoxGeometry(24, 7, 10),
    new THREE.MeshStandardMaterial({
      color: 0xd9c9b0,
      roughness: 0.72,
      metalness: 0.05,
    }),
  );
  stationBody.position.set(RAILWAY_STATION_X, RAILWAY_Y + 3.7, RAILWAY_Z - 19);
  stationBody.castShadow = true;
  stationBody.receiveShadow = true;
  railway.add(stationBody);

  const stationRoof = new THREE.Mesh(
    new THREE.BoxGeometry(28, 1.1, 14),
    new THREE.MeshStandardMaterial({
      color: 0x7b3d30,
      roughness: 0.78,
      metalness: 0.06,
    }),
  );
  stationRoof.position.set(RAILWAY_STATION_X, RAILWAY_Y + 7.8, RAILWAY_Z - 19);
  stationRoof.castShadow = true;
  railway.add(stationRoof);

  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(28, 0.5, 5.5),
    new THREE.MeshStandardMaterial({
      color: 0x6b7279,
      roughness: 0.58,
      metalness: 0.28,
    }),
  );
  canopy.position.set(RAILWAY_STATION_X, RAILWAY_Y + 4.3, RAILWAY_Z - 11.4);
  canopy.castShadow = true;
  railway.add(canopy);

  for (const postX of [-12, -4, 4, 12]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 4.2, 0.35),
      new THREE.MeshStandardMaterial({
        color: 0x7a7f82,
        roughness: 0.72,
        metalness: 0.2,
      }),
    );
    post.position.set(RAILWAY_STATION_X + postX, RAILWAY_Y + 2.2, RAILWAY_Z - 11.4);
    post.castShadow = true;
    railway.add(post);
  }

  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(7, 1.6, 0.3),
    new THREE.MeshStandardMaterial({
      color: 0x243647,
      emissive: 0x16222e,
      emissiveIntensity: 0.14,
      roughness: 0.5,
      metalness: 0.16,
    }),
  );
  sign.position.set(RAILWAY_STATION_X, RAILWAY_Y + 4.6, RAILWAY_Z - 8.3);
  railway.add(sign);

  const train = createTrain();
  railway.add(train);
  railwayTraffic.push({
    mesh: train,
    startX,
    endX,
    speed: 28,
    phase: 0.18,
  });

  scene.add(railway);
}

function createCity() {
  const city = new THREE.Group();
  const streetMaterial = new THREE.MeshStandardMaterial({
    color: 0x565b61,
    roughness: 0.9,
    metalness: 0.04,
  });
  const blockMaterial = new THREE.MeshStandardMaterial({
    color: 0x8ea0ad,
    roughness: 0.72,
    metalness: 0.08,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x89adc8,
    emissive: 0x284154,
    emissiveIntensity: 0.12,
    roughness: 0.16,
    metalness: 0.54,
  });

  for (let row = -1; row <= 1; row += 1) {
    const avenue = new THREE.Mesh(new THREE.BoxGeometry(86, 0.08, 8), streetMaterial);
    avenue.position.set(CITY_CENTER.x, terrainHeight(CITY_CENTER.x, CITY_CENTER.z + row * 26) + 0.03, CITY_CENTER.z + row * 26);
    avenue.receiveShadow = true;
    city.add(avenue);
  }

  for (let col = -1; col <= 1; col += 1) {
    const crossStreet = new THREE.Mesh(new THREE.BoxGeometry(8, 0.08, 72), streetMaterial);
    crossStreet.position.set(CITY_CENTER.x + col * 26, terrainHeight(CITY_CENTER.x + col * 26, CITY_CENTER.z) + 0.03, CITY_CENTER.z);
    crossStreet.receiveShadow = true;
    city.add(crossStreet);
  }

  const buildingFootprints = [
    { x: -134, z: -62, w: 14, d: 14, h: 18, color: 0xd6c6b8 },
    { x: -112, z: -62, w: 12, d: 12, h: 28, color: 0xb7c4cf },
    { x: -89, z: -61, w: 16, d: 14, h: 22, color: 0xc8d0d7 },
    { x: -132, z: -23, w: 12, d: 14, h: 15, color: 0xceb29c },
    { x: -108, z: -19, w: 18, d: 18, h: 34, color: 0x98a8b7 },
    { x: -84, z: -20, w: 13, d: 11, h: 19, color: 0xd7d8d2 },
  ];

  for (const footprint of buildingFootprints) {
    const groundY = terrainHeight(footprint.x, footprint.z);
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(footprint.w, footprint.h, footprint.d),
      new THREE.MeshStandardMaterial({
        color: footprint.color,
        roughness: 0.66,
        metalness: 0.08,
      }),
    );
    building.position.set(footprint.x, groundY + footprint.h * 0.5, footprint.z);
    building.castShadow = true;
    building.receiveShadow = true;
    city.add(building);

    const facade = new THREE.Mesh(
      new THREE.BoxGeometry(footprint.w * 0.72, footprint.h * 0.52, 0.36),
      glassMaterial,
    );
    facade.position.set(footprint.x, groundY + footprint.h * 0.56, footprint.z + footprint.d * 0.5 + 0.21);
    city.add(facade);
  }

  for (const plaza of [
    { x: -110, z: -42, w: 18, d: 18 },
    { x: -88, z: -42, w: 10, d: 10 },
  ]) {
    const square = new THREE.Mesh(
      new THREE.BoxGeometry(plaza.w, 0.12, plaza.d),
      blockMaterial,
    );
    square.position.set(plaza.x, terrainHeight(plaza.x, plaza.z) + 0.04, plaza.z);
    square.receiveShadow = true;
    city.add(square);
  }

  scene.add(city);
}

function createForest() {
  const forest = new THREE.Group();
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: 0x6e4b2f,
    roughness: 0.9,
    metalness: 0.02,
  });
  const foliageMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x3f6e36, roughness: 0.95, metalness: 0.01 }),
    new THREE.MeshStandardMaterial({ color: 0x567f41, roughness: 0.95, metalness: 0.01 }),
    new THREE.MeshStandardMaterial({ color: 0x2f5d31, roughness: 0.95, metalness: 0.01 }),
  ];

  for (let row = -3; row <= 3; row += 1) {
    for (let col = -3; col <= 3; col += 1) {
      const x = FOREST_CENTER.x + col * 11 + (row % 2) * 3;
      const z = FOREST_CENTER.z + row * 13 + (col % 2) * 2;
      const groundY = terrainHeight(x, z);
      const treeHeight = 5.5 + ((row + col + 12) % 4) * 1.4;
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.6, 0.8, treeHeight, 8),
        trunkMaterial,
      );
      trunk.position.set(x, groundY + treeHeight * 0.5, z);
      trunk.castShadow = true;
      forest.add(trunk);

      const foliage = new THREE.Mesh(
        new THREE.ConeGeometry(3.8 + ((row + col + 10) % 3) * 0.7, 7 + (row % 3) * 1.1, 10),
        foliageMaterials[Math.abs(row + col) % foliageMaterials.length],
      );
      foliage.position.set(x, groundY + treeHeight + 3.6, z);
      foliage.castShadow = true;
      foliage.receiveShadow = true;
      forest.add(foliage);
    }
  }

  scene.add(forest);
}

function createTrain() {
  const train = new THREE.Group();

  const locomotive = new THREE.Group();
  const locoBodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xc43d2f,
    roughness: 0.56,
    metalness: 0.12,
  });
  const darkMetalMaterial = new THREE.MeshStandardMaterial({
    color: 0x37444d,
    roughness: 0.56,
    metalness: 0.32,
  });
  const windowMaterial = new THREE.MeshStandardMaterial({
    color: 0x91b4c8,
    emissive: 0x365164,
    emissiveIntensity: 0.2,
    roughness: 0.18,
    metalness: 0.52,
  });

  const locoBase = new THREE.Mesh(new THREE.BoxGeometry(10, 3.4, 3.2), locoBodyMaterial);
  locoBase.position.y = 2.1;
  locoBase.castShadow = true;
  locomotive.add(locoBase);

  const locoCab = new THREE.Mesh(new THREE.BoxGeometry(3.4, 4.2, 3), locoBodyMaterial);
  locoCab.position.set(-2.2, 4.2, 0);
  locoCab.castShadow = true;
  locomotive.add(locoCab);

  const locoNose = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.9), darkMetalMaterial);
  locoNose.position.set(5.2, 1.9, 0);
  locoNose.castShadow = true;
  locomotive.add(locoNose);

  const locoWindow = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 0.18), windowMaterial);
  locoWindow.position.set(-2.3, 4.5, -1.42);
  locomotive.add(locoWindow);
  const locoWindow2 = locoWindow.clone();
  locoWindow2.position.z = 1.42;
  locomotive.add(locoWindow2);

  train.add(locomotive);

  for (let i = 0; i < 3; i += 1) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(9.2, 3.1, 3.1),
      new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? 0x2f6da3 : 0x2f8b63,
        roughness: 0.58,
        metalness: 0.14,
      }),
    );
    body.position.y = 2.05;
    body.castShadow = true;
    car.add(body);

    for (let w = -3; w <= 3; w += 2) {
      const windowPane = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.8, 0.18), windowMaterial);
      windowPane.position.set(w, 2.5, -1.42);
      car.add(windowPane);
      const oppositePane = windowPane.clone();
      oppositePane.position.z = 1.42;
      car.add(oppositePane);
    }

    car.position.x = -13 - i * 11;
    train.add(car);
  }

  for (const axle of [-4, 0, 4, -13, -17, -24, -28, -35, -39]) {
    for (const railOffset of [-1.18, 1.18]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14),
        darkMetalMaterial,
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(axle, 0.62, railOffset);
      wheel.castShadow = true;
      train.add(wheel);
    }
  }

  train.position.set(0, RAILWAY_Y, RAILWAY_Z);
  train.rotation.y = Math.PI;
  return train;
}

function createPersonalPlane(config) {
  const airplane = new THREE.Group();
  airplane.scale.setScalar(config.scale ?? 0.42);

  const fuselageMaterial = new THREE.MeshStandardMaterial({
    color: config.body,
    roughness: 0.4,
    metalness: 0.2,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: config.accent,
    roughness: 0.5,
    metalness: 0.16,
  });
  const detailMaterial = new THREE.MeshStandardMaterial({
    color: 0x34414a,
    roughness: 0.56,
    metalness: 0.14,
  });

  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.55, 15, 18), fuselageMaterial);
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.y = 2.2;
  fuselage.castShadow = true;
  airplane.add(fuselage);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(1.28, 16, 14), fuselageMaterial);
  nose.scale.set(1.35, 1, 1);
  nose.position.set(7.7, 2.2, 0);
  nose.castShadow = true;
  airplane.add(nose);

  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(1.25, 3.4, 16), fuselageMaterial);
  tailCone.rotation.z = -Math.PI / 2;
  tailCone.position.set(-8.6, 2.2, 0);
  tailCone.castShadow = true;
  airplane.add(tailCone);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.16, 18), accentMaterial);
  wing.position.set(0.5, 2.1, 0);
  wing.castShadow = true;
  airplane.add(wing);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.14, 6.2), accentMaterial);
  tailWing.position.set(-6.7, 3.2, 0);
  tailWing.castShadow = true;
  airplane.add(tailWing);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 3.7, 0.24), accentMaterial);
  fin.position.set(-7.6, 4.25, 0);
  fin.castShadow = true;
  airplane.add(fin);

  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 2), detailMaterial);
  cockpit.position.set(4.4, 3, 0);
  cockpit.castShadow = true;
  airplane.add(cockpit);

  for (const zOffset of [-3.6, 3.6]) {
    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.68, 2.1, 12), detailMaterial);
    engine.rotation.z = Math.PI / 2;
    engine.position.set(1.1, 1.35, zOffset);
    engine.castShadow = true;
    airplane.add(engine);
  }

  return airplane;
}

function createPersonalCar(config) {
  const car = new THREE.Group();
  car.scale.setScalar(config.scale ?? 1);

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: config.body ?? 0xc73a3a,
    roughness: 0.42,
    metalness: 0.16,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: config.accent ?? 0xe6ecf4,
    roughness: 0.24,
    metalness: 0.38,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x99c6de,
    emissive: 0x294a5a,
    emissiveIntensity: 0.22,
    roughness: 0.12,
    metalness: 0.5,
    transparent: true,
    opacity: 0.88,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({
    color: 0x16181b,
    roughness: 0.9,
    metalness: 0.04,
  });

  const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.75, 5), bodyMaterial);
  lowerBody.position.y = 0.65;
  car.add(lowerBody);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.95, 2.4), bodyMaterial);
  cabin.position.set(0, 1.35, -0.25);
  car.add(cabin);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.72, 0.12), glassMaterial);
  windshield.position.set(0, 1.42, 0.92);
  windshield.rotation.x = -0.42;
  car.add(windshield);

  const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.56, 0.12), glassMaterial);
  rearGlass.position.set(0, 1.36, -1.36);
  rearGlass.rotation.x = 0.48;
  car.add(rearGlass);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(2.22, 0.16, 1.25), accentMaterial);
  hood.position.set(0, 1.06, 1.42);
  car.add(hood);

  for (const side of [-1, 1]) {
    const sideWindow = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.58, 1.76), glassMaterial);
    sideWindow.position.set(side * 1.02, 1.42, -0.22);
    car.add(sideWindow);
  }

  for (const side of [-1, 1]) {
    for (const axleZ of [-1.45, 1.45]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.42, 18), tireMaterial);
      wheel.rotation.z = Math.PI * 0.5;
      wheel.position.set(side * 1.3, 0.42, axleZ);
      car.add(wheel);

      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.46, 14), accentMaterial);
      rim.rotation.z = Math.PI * 0.5;
      rim.position.set(side * 1.3, 0.42, axleZ);
      car.add(rim);
    }
  }

  return car;
}

function createAirliner(config) {
  const airplane = new THREE.Group();
  airplane.scale.setScalar(0.45);

  const fuselageMaterial = new THREE.MeshStandardMaterial({
    color: config.body,
    roughness: 0.42,
    metalness: 0.18,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: config.accent,
    roughness: 0.5,
    metalness: 0.14,
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x32414a,
    roughness: 0.55,
    metalness: 0.12,
  });

  const fuselage = new THREE.Mesh(
    new THREE.CylinderGeometry(1.65, 1.85, 20, 20),
    fuselageMaterial,
  );
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.y = 2.5;
  fuselage.castShadow = true;
  airplane.add(fuselage);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(1.6, 18, 16), fuselageMaterial);
  nose.scale.set(1.3, 1, 1);
  nose.position.set(10.1, 2.5, 0);
  nose.castShadow = true;
  airplane.add(nose);

  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(1.55, 4, 18), fuselageMaterial);
  tailCone.rotation.z = -Math.PI / 2;
  tailCone.position.set(-11.2, 2.5, 0);
  tailCone.castShadow = true;
  airplane.add(tailCone);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.18, 24), accentMaterial);
  wing.position.set(1.4, 2.45, 0);
  wing.castShadow = true;
  airplane.add(wing);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.14, 7.5), accentMaterial);
  tailWing.position.set(-8.5, 3.8, 0);
  tailWing.castShadow = true;
  airplane.add(tailWing);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 4.8, 0.26), accentMaterial);
  fin.position.set(-9.6, 4.9, 0);
  fin.castShadow = true;
  airplane.add(fin);

  for (const zOffset of [-4.6, 4.6]) {
    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.82, 2.6, 14), darkMaterial);
    engine.rotation.z = Math.PI / 2;
    engine.position.set(1.8, 1.45, zOffset);
    engine.castShadow = true;
    airplane.add(engine);
  }

  for (const wheel of [
    { x: -4.5, y: 0.68, z: -1.6 },
    { x: -4.5, y: 0.68, z: 1.6 },
    { x: 7.8, y: 0.72, z: 0 },
  ]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.2, 0.14), darkMaterial);
    strut.position.set(wheel.x, 1.28, wheel.z);
    airplane.add(strut);

    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 12), darkMaterial);
    tire.rotation.z = Math.PI / 2;
    tire.position.set(wheel.x, wheel.y, wheel.z);
    tire.castShadow = true;
    airplane.add(tire);
  }

  for (let i = -7; i <= 6; i += 1) {
    const windowMesh = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.08), darkMaterial);
    windowMesh.position.set(i * 1.1, 3.1, -1.68);
    airplane.add(windowMesh);

    const mirrored = windowMesh.clone();
    mirrored.position.z = 1.68;
    airplane.add(mirrored);
  }

  return airplane;
}

function createConcorde(config) {
  const airplane = new THREE.Group();
  airplane.scale.setScalar(config.scale ?? 0.52);

  const fuselageMaterial = new THREE.MeshStandardMaterial({
    color: config.body,
    roughness: 0.38,
    metalness: 0.22,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: config.accent,
    roughness: 0.46,
    metalness: 0.18,
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f3943,
    roughness: 0.54,
    metalness: 0.14,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9dce2,
    roughness: 0.34,
    metalness: 0.24,
  });

  const fuselageSections = [
    { geometry: new THREE.CylinderGeometry(1.12, 1.26, 15, 20), x: -4.6, y: 2.78 },
    { geometry: new THREE.CylinderGeometry(0.92, 1.12, 12, 20), x: 9.1, y: 2.7 },
  ];
  for (const section of fuselageSections) {
    const mesh = new THREE.Mesh(section.geometry, fuselageMaterial);
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set(section.x, section.y, 0);
    mesh.castShadow = true;
    airplane.add(mesh);
  }

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.64, 12.5, 18), fuselageMaterial);
  nose.rotation.z = -Math.PI / 2 - THREE.MathUtils.degToRad(10);
  nose.position.set(21.2, 2.18, 0);
  nose.castShadow = true;
  airplane.add(nose);

  const droopNose = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.34, 0.72), trimMaterial);
  droopNose.position.set(16.6, 2.02, 0);
  droopNose.rotation.z = THREE.MathUtils.degToRad(-11);
  droopNose.castShadow = true;
  airplane.add(droopNose);

  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.28, 1.0), darkMaterial);
  cockpit.position.set(15.5, 2.86, 0);
  cockpit.rotation.z = THREE.MathUtils.degToRad(-8);
  airplane.add(cockpit);

  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(1.0, 6.4, 18), fuselageMaterial);
  tailCone.rotation.z = -Math.PI / 2;
  tailCone.position.set(-19.2, 2.74, 0);
  tailCone.castShadow = true;
  airplane.add(tailCone);

  const spine = new THREE.Mesh(new THREE.BoxGeometry(24, 0.16, 0.22), accentMaterial);
  spine.position.set(-0.5, 3.42, 0);
  airplane.add(spine);

  const wingGeometry = new THREE.BufferGeometry();
  const wingVertices = new Float32Array([
    -14.5, 2.36, 0,
    0.8, 2.36, -14.6,
    12.8, 2.36, -1.5,
    -14.5, 2.36, 0,
    12.8, 2.36, -1.5,
    5.6, 2.36, -0.6,

    -14.5, 2.36, 0,
    0.8, 2.36, 14.6,
    12.8, 2.36, 1.5,
    -14.5, 2.36, 0,
    12.8, 2.36, 1.5,
    5.6, 2.36, 0.6,
  ]);
  wingGeometry.setAttribute("position", new THREE.BufferAttribute(wingVertices, 3));
  wingGeometry.computeVertexNormals();
  const wing = new THREE.Mesh(wingGeometry, accentMaterial);
  wing.castShadow = true;
  wing.receiveShadow = true;
  airplane.add(wing);

  const wingRoot = new THREE.Mesh(new THREE.BoxGeometry(8, 0.12, 2.8), trimMaterial);
  wingRoot.position.set(3.8, 2.42, 0);
  airplane.add(wingRoot);

  const finGeometry = new THREE.BufferGeometry();
  const finVertices = new Float32Array([
    -17.8, 2.8, 0,
    -15.9, 7.9, 0,
    -13.5, 2.9, 0,
  ]);
  finGeometry.setAttribute("position", new THREE.BufferAttribute(finVertices, 3));
  finGeometry.computeVertexNormals();
  const fin = new THREE.Mesh(finGeometry, accentMaterial);
  fin.castShadow = true;
  fin.receiveShadow = true;
  airplane.add(fin);

  const tailPlane = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 4.8), accentMaterial);
  tailPlane.position.set(-15.2, 4.75, 0);
  tailPlane.castShadow = true;
  airplane.add(tailPlane);

  for (const engine of [
    { x: -0.8, y: 1.5, z: -3.2 },
    { x: 4.4, y: 1.55, z: -6.1 },
    { x: -0.8, y: 1.5, z: 3.2 },
    { x: 4.4, y: 1.55, z: 6.1 },
  ]) {
    const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.68, 4.2, 14), darkMaterial);
    nacelle.rotation.z = Math.PI / 2;
    nacelle.position.set(engine.x, engine.y, engine.z);
    nacelle.castShadow = true;
    airplane.add(nacelle);

    const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.28, 14), trimMaterial);
    intake.rotation.z = Math.PI / 2;
    intake.position.set(engine.x + 2.02, engine.y, engine.z);
    airplane.add(intake);
  }

  for (const wheel of [
    { x: -4.8, y: 0.7, z: -1.2 },
    { x: -4.8, y: 0.7, z: 1.2 },
    { x: -1.9, y: 0.7, z: -1.2 },
    { x: -1.9, y: 0.7, z: 1.2 },
    { x: 14.4, y: 0.74, z: 0 },
  ]) {
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.2, 12), darkMaterial);
    tire.rotation.z = Math.PI / 2;
    tire.position.set(wheel.x, wheel.y, wheel.z);
    tire.castShadow = true;
    airplane.add(tire);
  }

  for (let i = -10; i <= 8; i += 1) {
    const windowMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), darkMaterial);
    windowMesh.position.set(i * 1.14, 3.1, -0.98);
    airplane.add(windowMesh);

    const mirrored = windowMesh.clone();
    mirrored.position.z = 0.98;
    airplane.add(mirrored);
  }

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(30, 0.12, 0.18), accentMaterial);
  stripe.position.set(1.2, 2.96, 0);
  airplane.add(stripe);

  return airplane;
}

function updateAirportTraffic(elapsedTime) {
  for (const plane of airportTraffic) {
    const hidden = plane.hiddenUntil && elapsedTime < plane.hiddenUntil;
    plane.mesh.visible = !hidden;
    if (hidden) {
      continue;
    }

    const cycle = ((elapsedTime / plane.cycleDuration) + plane.phase) % 1;
    const thresholdNorth = AIRPORT_CENTER.z - AIRPORT_RUNWAY_LENGTH * 0.5 + 8;
    const thresholdSouth = AIRPORT_CENTER.z + AIRPORT_RUNWAY_LENGTH * 0.5 - 8;
    const sample = sampleAirportTrafficState(plane, cycle, thresholdNorth, thresholdSouth);
    const nextTime = elapsedTime + 0.08;
    const nextCycle = ((nextTime / plane.cycleDuration) + plane.phase) % 1;
    const nextSample = sampleAirportTrafficState(plane, nextCycle, thresholdNorth, thresholdSouth);
    const dx = nextSample.x - sample.x;
    const dy = nextSample.y - sample.y;
    const dz = nextSample.z - sample.z;
    const horizontalLength = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, Math.max(0.001, horizontalLength));

    plane.mesh.position.set(sample.x, sample.y, sample.z);
    plane.mesh.rotation.set(0, yaw, 0, "YXZ");
    plane.mesh.rotateY(-Math.PI / 2);
    plane.mesh.rotateZ(-pitch * 0.35);

    const onRunway = sample.y <= airportBaseTerrainHeight() + 1.62 && sample.z >= thresholdNorth && sample.z <= thresholdSouth;
    if (onRunway && !plane.wasOnRunway) {
      createTouchdownSmoke(sample.x, airportBaseTerrainHeight(), sample.z, yaw, 0.9);
    }
    plane.wasOnRunway = onRunway;
  }
}

function sampleAirportTrafficState(plane, cycle, thresholdNorth, thresholdSouth) {
  const x = AIRPORT_CENTER.x + plane.runwayOffsetX;
  const runwayBaseY = airportBaseTerrainHeight();
  let z = thresholdNorth;
  let altitude = 0;
  let worldX = x;

  if (cycle < 0.28) {
    const t = cycle / 0.28;
    z = THREE.MathUtils.lerp(thresholdNorth - plane.approachDistance, thresholdNorth, t);
    altitude = THREE.MathUtils.lerp(plane.cruiseAltitude, 1.6, smoothstep(t));
  } else if (cycle < 0.46) {
    const t = (cycle - 0.28) / 0.18;
    z = THREE.MathUtils.lerp(thresholdNorth, thresholdSouth - 16, t);
    altitude = 1.6;
  } else if (cycle < 0.56) {
    const t = (cycle - 0.46) / 0.1;
    z = THREE.MathUtils.lerp(thresholdSouth - 16, thresholdSouth, t);
    altitude = THREE.MathUtils.lerp(1.6, 2.4, t);
  } else if (cycle < 0.78) {
    const t = (cycle - 0.56) / 0.22;
    z = THREE.MathUtils.lerp(thresholdSouth, thresholdSouth + plane.departureDistance, t);
    altitude = THREE.MathUtils.lerp(2.4, plane.cruiseAltitude, smoothstep(t));
  } else {
    const t = (cycle - 0.78) / 0.22;
    const turnWidth = 44 + plane.departureDistance * 0.12;
    worldX = x + turnWidth * plane.turnSide;
    z = THREE.MathUtils.lerp(thresholdSouth + plane.departureDistance, thresholdNorth - plane.approachDistance, t);
    altitude = THREE.MathUtils.lerp(plane.cruiseAltitude, plane.cruiseAltitude - 2, t);
  }

  const terrainY = runwayBaseY;
  return {
    x: worldX,
    y: terrainY + altitude,
    z,
  };
}

function updateRailwayTraffic(elapsedTime) {
  for (const train of railwayTraffic) {
    const distance = train.endX - train.startX;
    const offset = ((elapsedTime * train.speed) + distance * train.phase) % distance;
    train.mesh.position.x = train.startX + offset;
  }
}

function terrainBaseForSphereAt(x, z, radius) {
  let requiredCenterY = terrainHeight(x, z) + radius;

  const rings = [
    { scale: 0.5, samples: 8 },
    { scale: 0.95, samples: 12 },
  ];

  for (const ring of rings) {
    const d = radius * ring.scale;
    const centerLift = Math.sqrt(Math.max(0, radius * radius - d * d));
    for (let i = 0; i < ring.samples; i += 1) {
      const angle = (i / ring.samples) * Math.PI * 2;
      const sx = x + Math.cos(angle) * d;
      const sz = z + Math.sin(angle) * d;
      const h = terrainHeight(sx, sz);
      requiredCenterY = Math.max(requiredCenterY, h + centerLift);
    }
  }

  return requiredCenterY - radius - GROUND_CONTACT_VISUAL_BIAS;
}

function fbm(x, z, octaves, lacunarity, gain) {
  let sum = 0;
  let amp = 1;
  let freq = 1;

  for (let i = 0; i < octaves; i += 1) {
    sum += amp * valueNoise(x * freq, z * freq);
    freq *= lacunarity;
    amp *= gain;
  }

  return sum;
}

function valueNoise(x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;

  const u = smoothstep(tx);
  const v = smoothstep(tz);

  const n00 = rand2(x0, z0);
  const n10 = rand2(x0 + 1, z0);
  const n01 = rand2(x0, z0 + 1);
  const n11 = rand2(x0 + 1, z0 + 1);

  const nx0 = THREE.MathUtils.lerp(n00, n10, u);
  const nx1 = THREE.MathUtils.lerp(n01, n11, u);
  return THREE.MathUtils.lerp(nx0, nx1, v) * 2 - 1;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function rand2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function sanitizeNickname(rawName) {
  if (typeof rawName !== "string") {
    return "pilot";
  }
  const cleaned = rawName.replace(/\s+/g, " ").trim().slice(0, 20);
  return cleaned.length > 0 ? cleaned : "pilot";
}

function normalizeAvatarColor(rawColor) {
  if (typeof rawColor !== "string") {
    return DEFAULT_AVATAR_COLOR;
  }
  const trimmed = rawColor.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return DEFAULT_AVATAR_COLOR;
}

function sanitizeAvatarPattern(rawPattern) {
  if (typeof rawPattern !== "string") {
    return DEFAULT_AVATAR_PATTERN;
  }
  return AVATAR_PATTERNS.has(rawPattern) ? rawPattern : DEFAULT_AVATAR_PATTERN;
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

function drawRoundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function createTerrainDetailTexture(rendererInstance) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  ctx.fillStyle = "#8aac70";
  ctx.fillRect(0, 0, size, size);

  // Macro checker gives better motion perception than fine noise alone.
  const macro = 32;
  for (let y = 0; y < size; y += macro) {
    for (let x = 0; x < size; x += macro) {
      const even = ((x / macro) + (y / macro)) % 2 === 0;
      ctx.fillStyle = even ? "rgba(120, 152, 96, 0.22)" : "rgba(86, 120, 68, 0.22)";
      ctx.fillRect(x, y, macro, macro);
    }
  }

  for (let i = 0; i < 3600; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const shade = 112 + Math.floor(Math.random() * 72);
    ctx.fillStyle = `rgb(${shade - 22}, ${shade}, ${shade - 28})`;
    ctx.fillRect(x, y, 1, 1);
  }

  ctx.strokeStyle = "rgba(55, 82, 44, 0.45)";
  ctx.lineWidth = 1;
  for (let i = -size; i < size * 2; i += 20) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i - size, size);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(132, 170, 108, 0.22)";
  for (let i = 0; i <= size; i += 32) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(56, 56);
  texture.anisotropy = rendererInstance.capabilities.getMaxAnisotropy();
  return texture;
}

function createTouchdownSmokeTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(48, 48, 8, 48, 48, 48);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.35, "rgba(210,216,223,0.72)");
  gradient.addColorStop(0.7, "rgba(120,130,142,0.32)");
  gradient.addColorStop(1, "rgba(90,100,110,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}
