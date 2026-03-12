import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const portsConfigPath = path.join(scriptDir, "dev-ports.json");
const portsConfig = readPortsConfig(portsConfigPath);
const appPort = portsConfig.appPort;
const wsPort = portsConfig.wsPort;
const externalIp = readExternalIp([
  path.resolve(scriptDir, "../../.ip"),
  path.resolve(scriptDir, "../../.wsl_external_ip"),
]);
const studentHost = externalIp || "localhost";
const studentUrl = `http://${studentHost}:${appPort}/`;

console.log("");
console.log("===============================================");
console.log(`[dev] STUDENTS: open this URL in browser`);
console.log(`[dev] ${studentUrl}`);
console.log("===============================================");
console.log("");

const processes = [
  {
    name: "client",
    cmd: "npm",
    args: ["--prefix", "packages/client", "run", "dev", "--", "--host", "--port", String(appPort)],
    env: {
      VITE_WS_PORT: String(wsPort),
      VITE_APP_PORT: String(appPort),
    },
  },
  {
    name: "server",
    cmd: "npm",
    args: ["--prefix", "packages/server", "run", "dev"],
    env: {
      PORT: String(wsPort),
      CLIENT_PORT: String(appPort),
    },
  },
];

const children = processes.map(({ name, cmd, args, env }) => {
  const child = spawn(cmd, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      ...env,
    },
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(1);
    }
  });

  return child;
});

let stopping = false;
function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function readPortsConfig(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`[dev] failed to read ${configPath}: ${error.message}`);
    process.exit(1);
  }

  const appPort = toValidPort(parsed.appPort, "appPort");
  const wsPort = toValidPort(parsed.wsPort, "wsPort");
  return { appPort, wsPort };
}

function toValidPort(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`[dev] invalid ${name} in scripts/dev-ports.json: ${value}`);
    process.exit(1);
  }
  return parsed;
}

function readExternalIp(filePaths) {
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const raw = readFileSync(filePath, "utf8");
      const value = raw.split(/\r?\n/)[0]?.trim();
      if (value) {
        return value;
      }
    } catch {
      // Ignore unreadable files and continue to the next fallback path.
    }
  }
  return null;
}
