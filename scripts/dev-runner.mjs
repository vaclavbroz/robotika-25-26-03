import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";
import path from "node:path";

const repoRootArg = process.argv[2];

if (!repoRootArg) {
  console.error("[dev] usage: node scripts/dev-runner.mjs /path/to/project");
  process.exit(1);
}

const repoRoot = path.resolve(repoRootArg);
const workspaceRoot = path.dirname(repoRoot);
const { appPort, wsPort } = deriveDevPorts(repoRoot, workspaceRoot);
const externalIp = readExternalIp(path.join(workspaceRoot, ".ip"));
const studentHost = externalIp || "localhost";
const studentUrl = `http://${studentHost}:${appPort}/`;
const childLogFilters = [/^\s*➜\s+Local:/, /^\s*➜\s+Network:/, /^\s*➜\s+press h \+ enter/i, /^\[server\] client url /];
const restartPortCheckIntervalMs = 200;
const restartPortWaitTimeoutMs = 5000;
const portKillWaitTimeoutMs = 3000;
const supportedKeys = [
  { key: "r", description: "restart client and server" },
  { key: "q", description: "stop client and server and exit" },
  { key: "h", description: "show this help" },
];

console.log("");
await ensurePortsAvailable([appPort, wsPort], "startup");

const processes = [
  {
    name: "client",
    cmd: "npm",
    args: [
      "--silent",
      "--prefix",
      "packages/client",
      "run",
      "dev",
      "--",
      "--host",
      "--port",
      String(appPort),
      "--logLevel",
      "error",
    ],
    env: {
      VITE_WS_PORT: String(wsPort),
      VITE_APP_PORT: String(appPort),
    },
  },
  {
    name: "server",
    cmd: "npm",
    args: ["--silent", "--prefix", "packages/server", "run", "dev"],
    env: {
      PORT: String(wsPort),
      CLIENT_PORT: String(appPort),
      QUIET_STARTUP_LOGS: "1",
    },
  },
];

let children = [];
let stopping = false;
let restartRequested = false;

startChildren();
await printStartupBanner();
printControls();
setupKeyboardControls();

function startChildren() {
  children = processes.map(({ name, cmd, args, env }) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env,
      },
    });

    child.stdout.on("data", createChildLogRelay(name, process.stdout));
    child.stderr.on("data", createChildLogRelay(name, process.stderr));

    child.on("exit", (code, signal) => {
      if (stopping) {
        return;
      }

      if (restartRequested) {
        if (allChildrenExited()) {
          void completeRestart();
        }
        return;
      }

      if (code !== 0 && signal !== "SIGTERM") {
        console.error(`[${name}] exited with code ${code}`);
        shutdown(1);
      }
    });

    return child;
  });
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  teardownKeyboardControls();
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 150);
}

function restartChildren() {
  if (stopping || restartRequested) {
    return;
  }

  restartRequested = true;
  console.log("[start] Restarting client and server...");
  for (const child of children) {
    child.kill("SIGTERM");
  }
}

async function completeRestart() {
  try {
    await ensurePortsAvailable([appPort, wsPort], "restart");
  } catch (error) {
    restartRequested = false;
    console.error(`[start] ${error.message}`);
    shutdown(1);
    return;
  }

  restartRequested = false;
  if (!stopping) {
    startChildren();
    await printStartupBanner();
    printControls();
  }
}

process.on("SIGINT", () => {
  if (process.stdin.isTTY) {
    printControls("Ctrl+C is disabled here.");
    return;
  }
  shutdown(0);
});
process.on("SIGTERM", () => shutdown(0));

function deriveDevPorts(rootDir, parentDir) {
  const appPortOverride = parseOptionalPort(process.env.APP_PORT, "APP_PORT");
  const wsPortOverride = parseOptionalPort(process.env.WS_PORT, "WS_PORT");
  const defaults = deriveDefaultPorts(rootDir, parentDir);
  const appPort = appPortOverride ?? defaults.appPort;
  const wsPort = wsPortOverride ?? defaults.wsPort;

  if (appPort === wsPort) {
    console.error(`[dev] APP_PORT and WS_PORT must be different, got: ${appPort}`);
    process.exit(1);
  }

  return { appPort, wsPort };
}

function deriveDefaultPorts(rootDir, parentDir) {
  const teamName = path.basename(rootDir);
  const match = /^team(\d+)$/.exec(teamName);

  if (!match || !isClassroomWorkspace(parentDir)) {
    return {
      appPort: 8000,
      wsPort: 9001,
    };
  }

  return deriveClassroomTeamPorts(teamName, match);
}

function deriveClassroomTeamPorts(teamName, match) {
  if (!match) {
    console.error(`[dev] expected repo folder name like team12, got: ${teamName}`);
    process.exit(1);
  }

  const teamNumber = Number.parseInt(match[1], 10);
  const appPort = 8000 + teamNumber;
  const wsPort = 9000 + teamNumber;

  if (!Number.isInteger(teamNumber) || teamNumber < 0) {
    console.error(`[dev] invalid team number in folder name: ${teamName}`);
    process.exit(1);
  }
  if (appPort > 65535 || wsPort > 65535) {
    console.error(`[dev] derived ports are out of range for ${teamName}`);
    process.exit(1);
  }

  return { appPort, wsPort };
}

function isClassroomWorkspace(parentDir) {
  return existsSync(path.join(parentDir, "common", "dev-runner.mjs"));
}

function parseOptionalPort(value, label) {
  if (value === undefined || value === "") {
    return null;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || String(port) !== String(value).trim() || port < 1 || port > 65535) {
    console.error(`[dev] ${label} must be an integer port from 1 to 65535, got: ${value}`);
    process.exit(1);
  }

  return port;
}

function readExternalIp(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const value = raw.split(/\r?\n/)[0]?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function createChildLogRelay(name, target) {
  let buffered = "";

  return (chunk) => {
    buffered += normalizeTerminalOutput(chunk.toString());
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      if (shouldSkipChildLogLine(line)) {
        continue;
      }
      target.write(`[${name}] ${line}\n`);
    }
  };
}

function normalizeTerminalOutput(value) {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

function shouldSkipChildLogLine(line) {
  if (line.trim() === "") {
    return true;
  }
  return childLogFilters.some((pattern) => pattern.test(line));
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve(true));
    });
  });
}

async function ensurePortsAvailable(ports, reason) {
  const pidToPorts = new Map();

  for (const port of ports) {
    if (await canListenOnPort(port)) {
      continue;
    }

    const pids = await findListeningPids(port);
    if (pids.length === 0) {
      throw new Error(`${reason} blocked: port ${port} is busy but no owner PID was found`);
    }

    console.log(`[start] Port ${port} is busy. Stopping PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")}.`);
    for (const pid of pids) {
      const ownedPorts = pidToPorts.get(pid) ?? [];
      ownedPorts.push(port);
      pidToPorts.set(pid, ownedPorts);
    }
  }

  if (pidToPorts.size > 0) {
    await terminatePids([...pidToPorts.keys()], "SIGTERM");
    const stubbornPids = await findRunningPids([...pidToPorts.keys()]);

    if (stubbornPids.length > 0) {
      console.log(`[start] Escalating to SIGKILL for PID${stubbornPids.length === 1 ? "" : "s"} ${stubbornPids.join(", ")}.`);
      await terminatePids(stubbornPids, "SIGKILL");
    }
  }

  await waitForPortsAvailable(ports, restartPortWaitTimeoutMs);
}

async function waitForPortsAvailable(ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const results = await Promise.all(ports.map((port) => canListenOnPort(port)));
    if (results.every(Boolean)) {
      return;
    }
    await sleep(restartPortCheckIntervalMs);
  }

  const stillBusy = [];
  for (const port of ports) {
    if (!(await canListenOnPort(port))) {
      stillBusy.push(port);
    }
  }

  throw new Error(`restart timed out waiting for ports: ${stillBusy.join(", ")}`);
}

async function waitForPortsInUse(ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const results = await Promise.all(ports.map((port) => canListenOnPort(port)));
    if (results.every((isAvailable) => !isAvailable)) {
      return;
    }
    await sleep(restartPortCheckIntervalMs);
  }

  const stillDown = [];
  for (const port of ports) {
    if (await canListenOnPort(port)) {
      stillDown.push(port);
    }
  }

  throw new Error(`startup timed out waiting for ports: ${stillDown.join(", ")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function printStartupBanner() {
  await waitForPortsInUse([wsPort], restartPortWaitTimeoutMs);
  console.log("");
  console.log("[start] Server started.");
  console.log("");
  console.log(`[start] Open in browser: ${studentUrl}`);
}

async function findListeningPids(port) {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-n",
      "-P",
      "-t",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
    ]);

    return [...new Set(
      stdout
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0 && value !== process.pid),
    )];
  } catch (error) {
    if (error.code === 1) {
      return [];
    }
    throw new Error(`failed to inspect port ${port}: ${error.message}`);
  }
}

async function terminatePids(pids, signal) {
  for (const pid of pids) {
    if (!isPidRunning(pid)) {
      continue;
    }

    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw new Error(`failed to send ${signal} to PID ${pid}: ${error.message}`);
      }
    }
  }

  await waitForPidsToExit(pids, portKillWaitTimeoutMs);
}

async function waitForPidsToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const running = await findRunningPids(pids);
    if (running.length === 0) {
      return;
    }
    await sleep(restartPortCheckIntervalMs);
  }
}

async function findRunningPids(pids) {
  return pids.filter((pid) => isPidRunning(pid));
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function setupKeyboardControls() {
  if (!process.stdin.isTTY) {
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", handleKeypress);
}

function teardownKeyboardControls() {
  if (!process.stdin.isTTY) {
    return;
  }

  process.stdin.off("keypress", handleKeypress);
  process.stdin.setRawMode(false);
}

function handleKeypress(_, key = {}) {
  if (key.ctrl && key.name === "c") {
    printControls("Ctrl+C is disabled here.");
    return;
  }

  if (key.name === "r") {
    restartChildren();
    return;
  }

  if (key.name === "q") {
    console.log("[start] Stopping client and server...");
    shutdown(0);
    return;
  }

  printControls();
}

function allChildrenExited() {
  return children.every((child) => child.exitCode !== null || child.signalCode !== null);
}

function printControls(prefix) {
  console.log("");

  if (prefix) {
    console.log(`[start] ${prefix}`);
  }

  console.log("[start] Controls:");
  for (const { key, description } of supportedKeys) {
    console.log(`[start]   ${key.padEnd(2, " ")}  ${description}`);
  }
  console.log("");
}
