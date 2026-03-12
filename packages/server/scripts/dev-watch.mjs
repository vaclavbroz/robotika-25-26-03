import { spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const restartDebounceMs = Number.parseInt(process.env.SERVER_RESTART_DEBOUNCE_MS || "1400", 10);
const watchRoots = [path.join(serverRoot, "src")];

let child = null;
let restartPending = false;
let restartReason = "code changes";
let restartTimer = null;
let shuttingDown = false;
const watchers = new Map();

startServer();
refreshWatchers();

process.on("SIGINT", () => stopWatcher(0));
process.on("SIGTERM", () => stopWatcher(0));

function startServer() {
  child = spawn(process.execPath, ["./src/index.js"], {
    cwd: serverRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DEV_AUTO_RESTART: "1",
      DEV_RESTART_NOTICE_MS: String(restartDebounceMs),
    },
  });

  child.on("exit", (code, signal) => {
    child = null;

    if (shuttingDown) {
      process.exit(code ?? (signal ? 1 : 0));
      return;
    }

    if (restartPending) {
      restartPending = false;
      console.log(`[dev-watch] restarting server after ${restartReason}`);
      startServer();
      return;
    }

    if (code !== 0) {
      process.exit(code ?? 1);
    }
  });
}

function scheduleRestart(reason) {
  if (shuttingDown) {
    return;
  }

  restartReason = reason;
  console.log(`[dev-watch] change detected, restarting in ${restartDebounceMs}ms`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!child || restartPending) {
      return;
    }
    restartPending = true;
    child.kill("SIGTERM");
  }, restartDebounceMs);
}

function stopWatcher(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearTimeout(restartTimer);
  closeWatchers();

  if (!child) {
    process.exit(exitCode);
    return;
  }

  child.once("exit", () => {
    process.exit(exitCode);
  });
  child.kill("SIGTERM");
}

function refreshWatchers() {
  const nextDirs = new Set();
  for (const rootDir of watchRoots) {
    collectDirectories(rootDir, nextDirs);
  }

  for (const [dirPath, watcher] of watchers) {
    if (nextDirs.has(dirPath)) {
      continue;
    }
    watcher.close();
    watchers.delete(dirPath);
  }

  for (const dirPath of nextDirs) {
    if (watchers.has(dirPath)) {
      continue;
    }
    const watcher = watch(dirPath, (eventType, filename) => {
      refreshWatchers();
      const label = filename ? path.relative(serverRoot, path.join(dirPath, filename)) : path.relative(serverRoot, dirPath);
      scheduleRestart(`${eventType} in ${label}`);
    });
    watcher.on("error", (error) => {
      console.error(`[dev-watch] watcher error on ${path.relative(serverRoot, dirPath)}: ${error.message}`);
    });
    watchers.set(dirPath, watcher);
  }
}

function closeWatchers() {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}

function collectDirectories(rootDir, directories) {
  let stats;
  try {
    stats = statSync(rootDir);
  } catch {
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  directories.add(rootDir);

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    collectDirectories(path.join(rootDir, entry.name), directories);
  }
}
