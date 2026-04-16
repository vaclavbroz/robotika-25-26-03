export class PlayerState {
  constructor({
    playerId,
    position,
    velocity,
    onGround,
    name,
    jumpRequested,
    jumpCooldownRemaining,
    moveX,
    moveZ,
    yaw,
    pitch,
    inPlane,
    inCar,
    planeSpeed,
    carSpeed,
    pendingPlaneCrash,
    avatar,
  }) {
    this.playerId = playerId;
    this.position = { ...position };
    this.velocity = { ...velocity };
    this.onGround = onGround;
    this.name = name;
    this.jumpRequested = jumpRequested;
    this.jumpCooldownRemaining = jumpCooldownRemaining;
    this.moveX = moveX;
    this.moveZ = moveZ;
    this.yaw = yaw;
    this.pitch = pitch;
    this.inPlane = inPlane;
    this.inCar = inCar;
    this.planeSpeed = planeSpeed;
    this.carSpeed = carSpeed;
    this.pendingPlaneCrash = pendingPlaneCrash ?? null;
    this.avatar = {
      color: normalizeAvatarColor(avatar?.color),
      pattern: sanitizeAvatarPattern(avatar?.pattern),
    };
  }

  static createInitial(playerId) {
    return new PlayerState({
      playerId,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: true,
      name: undefined,
      jumpRequested: false,
      jumpCooldownRemaining: 0,
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      pitch: 0,
      inPlane: false,
      inCar: false,
      planeSpeed: 0,
      carSpeed: 0,
      pendingPlaneCrash: null,
      avatar: {
        color: "#3c74d4",
        pattern: "stripes",
      },
    });
  }

  setName(rawName) {
    if (typeof rawName !== "string") {
      return;
    }
    this.name = rawName.slice(0, 32);
  }

  setAvatar(rawAvatar) {
    if (!rawAvatar || typeof rawAvatar !== "object") {
      return;
    }
    this.avatar = {
      color: normalizeAvatarColor(rawAvatar.color),
      pattern: sanitizeAvatarPattern(rawAvatar.pattern),
    };
  }

  requestJump() {
    this.jumpRequested = true;
  }

  applyInput(input) {
    const localX = clamp(input.moveX, -1, 1);
    const localZ = clamp(input.moveZ, -1, 1);
    const normalized = normalizeStick(localX, localZ);
    if (this.inCar) {
      this.moveX = normalized.x;
      this.moveZ = normalized.z;
      this.pitch = 0;
      if (input.jumpRequested) {
        this.requestJump();
      }
      return;
    }

    this.yaw = normalizeAngle(input.yaw);
    this.pitch = clamp(input.pitch, -Math.PI / 2, Math.PI / 2);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);

    this.moveX = normalized.x * cosYaw + normalized.z * sinYaw;
    this.moveZ = normalized.x * sinYaw - normalized.z * cosYaw;

    if (input.jumpRequested) {
      this.requestJump();
    }
  }

  simulateTick(dtSeconds, config) {
    if (this.inPlane) {
      this.simulatePlaneTick(dtSeconds, config);
      return;
    }
    if (this.inCar) {
      this.simulateCarTick(dtSeconds, config);
      return;
    }

    const control = this.onGround ? 1 : config.airControl;
    const accelStep = config.maxAcceleration * control * dtSeconds;

    this.velocity.x += this.moveX * accelStep;
    this.velocity.z += this.moveZ * accelStep;

    const friction = this.onGround ? config.friction : config.airFriction;
    applyHorizontalFriction(this.velocity, friction * dtSeconds);

    clampHorizontalSpeed(this.velocity, config.maxBumpSpeed ?? config.maxSpeed);

    const cooldown = Math.max(0, this.jumpCooldownRemaining - dtSeconds);
    this.jumpCooldownRemaining = cooldown;

    if (this.jumpRequested && this.onGround && this.jumpCooldownRemaining <= 0) {
      this.velocity.y = config.jumpSpeed;
      this.onGround = false;
      this.jumpCooldownRemaining = config.jumpCooldownSeconds;
    }
    this.jumpRequested = false;

    this.velocity.y -= config.gravity * dtSeconds;
    this.position.x += this.velocity.x * dtSeconds;
    this.position.y += this.velocity.y * dtSeconds;
    this.position.z += this.velocity.z * dtSeconds;

    if (this.position.y <= config.groundY) {
      this.position.y = config.groundY;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    this.enforceWorldBounds(config);
    this.enforceStaticObstacles(config);
  }

  simulatePlaneTick(dtSeconds, config) {
    const forwardInput = clamp(this.moveX * Math.sin(this.yaw) + this.moveZ * -Math.cos(this.yaw), -1, 1);
    const speedTarget =
      config.planeCruiseSpeed +
      Math.max(0, forwardInput) * config.planeBoostSpeed -
      Math.max(0, -forwardInput) * config.planeBrakeSpeed;
    this.planeSpeed = clamp(
      this.planeSpeed + (speedTarget - this.planeSpeed) * Math.min(1, dtSeconds * 2.5),
      config.planeMinSpeed,
      config.planeCruiseSpeed + config.planeBoostSpeed,
    );

    const directionX = Math.sin(this.yaw) * Math.cos(this.pitch);
    const directionY = Math.sin(this.pitch);
    const directionZ = -Math.cos(this.yaw) * Math.cos(this.pitch);

    this.velocity.x = directionX * this.planeSpeed;
    this.velocity.z = directionZ * this.planeSpeed;
    this.velocity.y = directionY * config.planeClimbRate;

    this.position.x += this.velocity.x * dtSeconds;
    this.position.y += this.velocity.y * dtSeconds;
    this.position.z += this.velocity.z * dtSeconds;
    this.position.y = Math.max(config.planeMinAltitude, this.position.y);
    this.onGround = this.position.y <= config.planeMinAltitude + 0.05;

    if (this.onGround && !isPlaneOnRunway(this.position, config)) {
      this.triggerPlaneCrash("off-runway-landing");
      return;
    }

    this.checkPlaneCrash(config);

    this.enforceWorldBounds(config);
  }

  simulateCarTick(dtSeconds, config) {
    const forwardInput = clamp(this.moveZ, -1, 1);
    const steerInput = clamp(this.moveX, -1, 1);
    const carMaxForwardSpeed = Math.max(0, config.carMaxForwardSpeed ?? 16);
    const carMaxReverseSpeed = Math.max(0, config.carMaxReverseSpeed ?? 7);
    const speedTarget =
      forwardInput >= 0 ? forwardInput * carMaxForwardSpeed : forwardInput * carMaxReverseSpeed;
    const response = Math.abs(speedTarget) > Math.abs(this.carSpeed)
      ? Math.max(0, config.carAcceleration ?? 20)
      : Math.max(0, config.carBrakeSpeed ?? 28);

    this.carSpeed += (speedTarget - this.carSpeed) * Math.min(1, dtSeconds * response);
    this.carSpeed = clamp(this.carSpeed, -carMaxReverseSpeed, carMaxForwardSpeed);

    const speedRatio = Math.min(1, Math.abs(this.carSpeed) / Math.max(1, carMaxForwardSpeed));
    this.yaw = normalizeAngle(
      this.yaw - steerInput * (config.carTurnSpeed ?? 2.2) * Math.max(0.25, speedRatio) * dtSeconds,
    );
    this.pitch = 0;
    this.velocity.x = Math.sin(this.yaw) * this.carSpeed;
    this.velocity.z = -Math.cos(this.yaw) * this.carSpeed;
    this.velocity.y = 0;
    this.position.x += this.velocity.x * dtSeconds;
    this.position.z += this.velocity.z * dtSeconds;
    this.position.y = config.groundY;
    this.onGround = true;

    this.enforceWorldBounds(config);
    this.enforceStaticObstacles(config);
  }

  enforceWorldBounds(config) {
    const boundedX = clamp(this.position.x, -config.worldHalfExtent, config.worldHalfExtent);
    if (boundedX !== this.position.x) {
      this.position.x = boundedX;
      this.velocity.x = 0;
    }

    const boundedZ = clamp(this.position.z, -config.worldHalfExtent, config.worldHalfExtent);
    if (boundedZ !== this.position.z) {
      this.position.z = boundedZ;
      this.velocity.z = 0;
    }
  }

  enforceStaticObstacles(config) {
    if (this.inPlane) {
      return;
    }
    const obstacles = Array.isArray(config.staticObstacles) ? config.staticObstacles : [];
    const radius = Number.isFinite(config.playerCollisionRadius) ? config.playerCollisionRadius : 0.75;

    for (const obstacle of obstacles) {
      if (obstacle?.type !== "rect") {
        continue;
      }

      const nearestX = clamp(this.position.x, obstacle.minX, obstacle.maxX);
      const nearestZ = clamp(this.position.z, obstacle.minZ, obstacle.maxZ);
      const dx = this.position.x - nearestX;
      const dz = this.position.z - nearestZ;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= radius * radius) {
        continue;
      }

      const insideX = this.position.x >= obstacle.minX && this.position.x <= obstacle.maxX;
      const insideZ = this.position.z >= obstacle.minZ && this.position.z <= obstacle.maxZ;

      if (insideX && insideZ) {
        const pushLeft = Math.abs(this.position.x - obstacle.minX);
        const pushRight = Math.abs(obstacle.maxX - this.position.x);
        const pushTop = Math.abs(this.position.z - obstacle.minZ);
        const pushBottom = Math.abs(obstacle.maxZ - this.position.z);
        const minPush = Math.min(pushLeft, pushRight, pushTop, pushBottom);

        if (minPush === pushLeft) {
          this.position.x = obstacle.minX - radius;
          this.velocity.x = Math.min(0, this.velocity.x);
        } else if (minPush === pushRight) {
          this.position.x = obstacle.maxX + radius;
          this.velocity.x = Math.max(0, this.velocity.x);
        } else if (minPush === pushTop) {
          this.position.z = obstacle.minZ - radius;
          this.velocity.z = Math.min(0, this.velocity.z);
        } else {
          this.position.z = obstacle.maxZ + radius;
          this.velocity.z = Math.max(0, this.velocity.z);
        }
        continue;
      }

      const distance = Math.sqrt(Math.max(distanceSq, 1e-8));
      const overlap = radius - distance;
      const nx = dx / distance;
      const nz = dz / distance;
      this.position.x += nx * overlap;
      this.position.z += nz * overlap;

      const velocityAlongNormal = this.velocity.x * nx + this.velocity.z * nz;
      if (velocityAlongNormal < 0) {
        this.velocity.x -= velocityAlongNormal * nx;
        this.velocity.z -= velocityAlongNormal * nz;
      }
    }
  }

  togglePlaneMode(config) {
    if (this.inPlane) {
      this.inPlane = false;
      this.planeSpeed = 0;
      this.position.y = Math.max(config.groundY, config.planeMinAltitude - 1.2);
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.velocity.z = 0;
      return true;
    }

    const parkedPlane = config.parkedPlane;
    if (!parkedPlane) {
      return false;
    }

    this.inPlane = true;
    this.inCar = false;
    this.position.x = parkedPlane.x;
    this.position.z = parkedPlane.z;
    this.position.y = config.planeMinAltitude + 0.6;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.planeSpeed = config.planeCruiseSpeed * 0.72;
    this.carSpeed = 0;
    return true;
  }

  toggleCarMode(config) {
    if (this.inCar) {
      const exitYaw = normalizeAngle(this.yaw);
      const exitOffset = 2.2;
      const exitSideX = Math.cos(exitYaw) * exitOffset;
      const exitSideZ = Math.sin(exitYaw) * exitOffset;
      this.inCar = false;
      this.carSpeed = 0;
      if (config.parkedCar) {
        config.parkedCar.x = this.position.x;
        config.parkedCar.z = this.position.z;
        config.parkedCar.yaw = exitYaw;
      }
      this.position.x += exitSideX;
      this.position.z += exitSideZ;
      this.yaw = exitYaw;
      this.pitch = 0;
      this.position.y = config.groundY;
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.velocity.z = 0;
      this.onGround = true;
      this.enforceWorldBounds(config);
      this.enforceStaticObstacles(config);
      return true;
    }

    const parkedCar = config.parkedCar;
    if (!parkedCar) {
      return false;
    }

    this.inPlane = false;
    this.inCar = true;
    this.position.x = parkedCar.x;
    this.position.z = parkedCar.z;
    this.position.y = config.groundY;
    this.yaw = normalizeAngle(Number.isFinite(parkedCar.yaw) ? parkedCar.yaw : 0);
    this.pitch = 0;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.planeSpeed = 0;
    this.carSpeed = 0;
    this.onGround = true;
    return true;
  }

  toggleVehicleMode(config) {
    if (this.inPlane) {
      return this.togglePlaneMode(config);
    }
    if (this.inCar) {
      return this.toggleCarMode(config);
    }

    const nearestVehicle = getNearestVehicle(this.position, config);
    if (!nearestVehicle) {
      return false;
    }

    if (nearestVehicle.type === "car") {
      return this.toggleCarMode(config);
    }
    return this.togglePlaneMode(config);
  }

  checkPlaneCrash(config) {
    const hazards = Array.isArray(config.planeCrashHazards) ? config.planeCrashHazards : [];
    for (const hazard of hazards) {
      if (
        this.position.x < hazard.minX ||
        this.position.x > hazard.maxX ||
        this.position.z < hazard.minZ ||
        this.position.z > hazard.maxZ
      ) {
        continue;
      }

      const collisionHeight = Number.isFinite(hazard.height) ? hazard.height : 10;
      if (this.position.y > collisionHeight) {
        continue;
      }

      this.triggerPlaneCrash(hazard.name ?? "obstacle");
      return;
    }
  }

  triggerPlaneCrash(hazard) {
    this.pendingPlaneCrash = {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      hazard,
    };
    this.inPlane = false;
    this.inCar = false;
    this.planeSpeed = 0;
    this.carSpeed = 0;
    this.position.y = 0;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.onGround = true;
  }

  consumePlaneCrash() {
    if (!this.pendingPlaneCrash) {
      return null;
    }
    const crash = this.pendingPlaneCrash;
    this.pendingPlaneCrash = null;
    return crash;
  }

  toJSON() {
    return {
      playerId: this.playerId,
      position: this.position,
      velocity: this.velocity,
      onGround: this.onGround,
      name: this.name,
      yaw: this.yaw,
      pitch: this.pitch,
      inPlane: this.inPlane,
      inCar: this.inCar,
      avatar: this.avatar,
    };
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const wrapped = ((value + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return wrapped;
}

function applyHorizontalFriction(velocity, amount) {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed === 0) {
    return;
  }
  const reduced = Math.max(0, speed - amount);
  if (reduced === 0) {
    velocity.x = 0;
    velocity.z = 0;
    return;
  }
  const scale = reduced / speed;
  velocity.x *= scale;
  velocity.z *= scale;
}

function clampHorizontalSpeed(velocity, maxSpeed) {
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  if (horizontalSpeed <= maxSpeed) {
    return;
  }
  const scale = maxSpeed / horizontalSpeed;
  velocity.x *= scale;
  velocity.z *= scale;
}

function normalizeStick(x, z) {
  const length = Math.hypot(x, z);
  if (length <= 1 || length === 0) {
    return { x, z };
  }
  return { x: x / length, z: z / length };
}

function normalizeAvatarColor(rawColor) {
  if (typeof rawColor !== "string") {
    return "#3c74d4";
  }
  const trimmed = rawColor.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return "#3c74d4";
}

function sanitizeAvatarPattern(rawPattern) {
  if (rawPattern === "stripes" || rawPattern === "checker") {
    return rawPattern;
  }
  return "stripes";
}

function isPlaneOnRunway(position, config) {
  const runway = config.runway;
  if (!runway) {
    return false;
  }

  const halfWidth = runway.width * 0.5;
  const halfLength = runway.length * 0.5;
  return (
    position.x >= runway.centerX - halfWidth &&
    position.x <= runway.centerX + halfWidth &&
    position.z >= runway.centerZ - halfLength &&
    position.z <= runway.centerZ + halfLength
  );
}

function getNearestVehicle(position, config) {
  const candidates = [];
  if (config.parkedCar) {
    candidates.push({ type: "car", ...config.parkedCar });
  }
  if (config.parkedPlane) {
    candidates.push({ type: "plane", ...config.parkedPlane });
  }

  let nearestVehicle = null;
  for (const vehicle of candidates) {
    const radius = Number.isFinite(vehicle.boardingRadius) ? vehicle.boardingRadius : 12;
    const distance = Math.hypot(position.x - vehicle.x, position.z - vehicle.z);
    if (distance > radius) {
      continue;
    }
    if (!nearestVehicle || distance < nearestVehicle.distance) {
      nearestVehicle = { ...vehicle, distance };
    }
  }
  return nearestVehicle;
}
