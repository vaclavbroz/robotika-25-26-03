import { PlayerState } from "./player-state.js";

export class WorldState {
  constructor() {
    this.tick = 0;
    this.players = new Map();
    this.recentCollisions = [];
    this.recentPlaneCrashes = [];
  }

  incrementTick() {
    this.tick += 1;
    return this.tick;
  }

  simulateTick(dtSeconds, config) {
    this.incrementTick();
    this.recentCollisions = [];
    this.recentPlaneCrashes = [];
    const previousPositionsById = new Map();
    for (const player of this.players.values()) {
      previousPositionsById.set(player.playerId, {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
      });
      player.simulateTick(dtSeconds, config);
      const planeCrash = player.consumePlaneCrash?.();
      if (planeCrash) {
        this.recentPlaneCrashes.push(planeCrash);
      }
    }
    this.resolvePlayerCollisions(config, previousPositionsById);
    return this.tick;
  }

  createPlayer(playerId) {
    const player = PlayerState.createInitial(playerId);
    this.players.set(playerId, player);
    return player;
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    this.players.delete(playerId);
    return player;
  }

  getPlayerCount() {
    return this.players.size;
  }

  createSnapshot() {
    return {
      tick: this.tick,
      players: Array.from(this.players.values()),
    };
  }

  resolvePlayerCollisions(config, previousPositionsById = new Map()) {
    const players = Array.from(this.players.values());
    if (players.length < 2) {
      return;
    }

    const radius = config.playerCollisionRadius ?? 0.75;
    const minDistance = radius * 2;
    const minDistanceSq = minDistance * minDistance;
    const restitution = clamp01(config.playerCollisionRestitution ?? 0.9);
    const iterations = Math.max(1, Math.floor(config.playerCollisionIterations ?? 2));
    const tiny = 1e-8;

    for (let pass = 0; pass < iterations; pass += 1) {
      for (let i = 0; i < players.length - 1; i += 1) {
        const a = players[i];
        for (let j = i + 1; j < players.length; j += 1) {
          const b = players[j];

          const dx = b.position.x - a.position.x;
          const dy = b.position.y - a.position.y;
          const dz = b.position.z - a.position.z;
          const distanceSq = dx * dx + dy * dy + dz * dz;
          if (distanceSq >= minDistanceSq) {
            continue;
          }

          let nx;
          let ny;
          let nz;
          let distance = Math.sqrt(distanceSq);
          if (distance <= tiny) {
            const rvx = b.velocity.x - a.velocity.x;
            const rvy = b.velocity.y - a.velocity.y;
            const rvz = b.velocity.z - a.velocity.z;
            const relativeLen = Math.hypot(rvx, rvy, rvz);
            if (relativeLen > tiny) {
              nx = rvx / relativeLen;
              ny = rvy / relativeLen;
              nz = rvz / relativeLen;
            } else {
              nx = 1;
              ny = 0;
              nz = 0;
            }
            distance = 0;
          } else {
            nx = dx / distance;
            ny = dy / distance;
            nz = dz / distance;
          }

          const penetration = minDistance - distance;
          if (penetration > 0) {
            const separation = penetration * 0.5;
            a.position.x -= nx * separation;
            a.position.y -= ny * separation;
            a.position.z -= nz * separation;
            b.position.x += nx * separation;
            b.position.y += ny * separation;
            b.position.z += nz * separation;
          }

          const previousA = previousPositionsById.get(a.playerId);
          const previousB = previousPositionsById.get(b.playerId);
          const previousDx = previousA && previousB ? previousB.x - previousA.x : 0;
          const previousDy = previousA && previousB ? previousB.y - previousA.y : 0;
          const previousDz = previousA && previousB ? previousB.z - previousA.z : 0;
          const previousDistance =
            previousA && previousB
              ? Math.hypot(previousDx, previousDy, previousDz)
              : Number.POSITIVE_INFINITY;
          const movedCloserThisTick = Number.isFinite(previousDistance) && previousDistance > distance;

          let rvx = b.velocity.x - a.velocity.x;
          let rvy = b.velocity.y - a.velocity.y;
          let rvz = b.velocity.z - a.velocity.z;
          let closingVelocity = rvx * nx + rvy * ny + rvz * nz;
          if (closingVelocity >= 0 && movedCloserThisTick && previousDistance > tiny) {
            nx = previousDx / previousDistance;
            ny = previousDy / previousDistance;
            nz = previousDz / previousDistance;
            rvx = b.velocity.x - a.velocity.x;
            rvy = b.velocity.y - a.velocity.y;
            rvz = b.velocity.z - a.velocity.z;
            closingVelocity = rvx * nx + rvy * ny + rvz * nz;
          }

          if (closingVelocity < 0) {
            const impulseMagnitude = (-(1 + restitution) * closingVelocity) / 2;
            const impulseX = nx * impulseMagnitude;
            const impulseY = ny * impulseMagnitude;
            const impulseZ = nz * impulseMagnitude;
            a.velocity.x -= impulseX;
            a.velocity.y -= impulseY;
            a.velocity.z -= impulseZ;
            b.velocity.x += impulseX;
            b.velocity.y += impulseY;
            b.velocity.z += impulseZ;

            if (pass === 0 && impulseMagnitude > 0.08) {
              this.recentCollisions.push({
                x: (a.position.x + b.position.x) * 0.5,
                y: (a.position.y + b.position.y) * 0.5,
                z: (a.position.z + b.position.z) * 0.5,
                intensity: impulseMagnitude,
              });
            }
          }

          a.enforceWorldBounds(config);
          b.enforceWorldBounds(config);
          a.enforceStaticObstacles(config);
          b.enforceStaticObstacles(config);
          enforceGroundContact(a, config);
          enforceGroundContact(b, config);
        }
      }
    }
  }
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function enforceGroundContact(player, config) {
  if (player.position.y <= config.groundY) {
    player.position.y = config.groundY;
    if (player.velocity.y < 0) {
      player.velocity.y = 0;
    }
    player.onGround = true;
    return;
  }

  player.onGround = false;
}
