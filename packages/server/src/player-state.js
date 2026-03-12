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
    planeSpeed,
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
    this.planeSpeed = planeSpeed;
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
      planeSpeed: 0,
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
    this.yaw = normalizeAngle(input.yaw);
    this.pitch = clamp(input.pitch, -Math.PI / 2, Math.PI / 2);
    const localX = clamp(input.moveX, -1, 1);
    const localZ = clamp(input.moveZ, -1, 1);
    const normalized = normalizeStick(localX, localZ);
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

    this.checkPlaneCrash(config);

    this.enforceWorldBounds(config);
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
    this.position.x = parkedPlane.x;
    this.position.z = parkedPlane.z;
    this.position.y = config.planeMinAltitude;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.planeSpeed = config.planeCruiseSpeed * 0.72;
    return true;
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

      this.pendingPlaneCrash = {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
        hazard: hazard.name ?? "obstacle",
      };
      this.inPlane = false;
      this.planeSpeed = 0;
      this.position.y = 0;
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.velocity.z = 0;
      this.onGround = true;
      return;
    }
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
