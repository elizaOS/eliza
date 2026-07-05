import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");
export const DEFAULT_HOST_AGENT_HOST = "127.0.0.1";
export const DEFAULT_HOST_AGENT_PORT = 31338;
const DEFAULT_HEALTH_ATTEMPTS = 90;
const DEFAULT_HEALTH_DELAY_MS = 2000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

export function parsePositivePort(raw, label = "port") {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return port;
}

export async function isTcpPortAvailable(port, host = DEFAULT_HOST_AGENT_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findOpenTcpPort(host = DEFAULT_HOST_AGENT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Failed to allocate a free TCP port."));
      });
    });
  });
}

export function resolveHostAgentRequestedPort(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const index = argv.indexOf("--host-agent-port");
  if (index >= 0) {
    return parsePositivePort(argv[index + 1], "--host-agent-port");
  }
  return parsePositivePort(env?.ELIZA_HOST_AGENT_PORT, "ELIZA_HOST_AGENT_PORT");
}

export async function chooseHostAgentPort({
  requestedPort = null,
  preferredPort = DEFAULT_HOST_AGENT_PORT,
  host = DEFAULT_HOST_AGENT_HOST,
  checkPortAvailable = isTcpPortAvailable,
  allocateFreePort = findOpenTcpPort,
} = {}) {
  const requested = parsePositivePort(requestedPort, "host agent port");
  if (requested) {
    if (!(await checkPortAvailable(requested, host))) {
      throw new Error(`Host-agent port ${requested} is already in use.`);
    }
    return requested;
  }

  const preferred = parsePositivePort(
    preferredPort,
    "preferred host-agent port",
  );
  if (preferred && (await checkPortAvailable(preferred, host))) {
    return preferred;
  }
  return allocateFreePort(host);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHealth(apiBase, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}/api/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function readLogTail(logPath, maxBytes = 8000) {
  if (!logPath || !fs.existsSync(logPath)) return "";
  const stat = fs.statSync(logPath);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export async function waitForHostAgentHealth({
  apiBase,
  child,
  getChildError = () => null,
  logPath,
  attempts = DEFAULT_HEALTH_ATTEMPTS,
  delayMs = DEFAULT_HEALTH_DELAY_MS,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const childError = getChildError();
    if (childError) {
      const tail = readLogTail(logPath);
      throw new Error(
        `Host agent failed to start: ${childError.message}.${tail ? `\n${tail}` : ""}`,
      );
    }
    const childExitCode = child?.exitCode;
    const childSignalCode = child?.signalCode;
    if (
      (childExitCode !== null && childExitCode !== undefined) ||
      (childSignalCode !== null && childSignalCode !== undefined)
    ) {
      const tail = readLogTail(logPath);
      throw new Error(
        `Host agent exited before /api/health became ready (${childSignalCode ? `signal ${childSignalCode}` : `exit ${childExitCode}`}).${tail ? `\n${tail}` : ""}`,
      );
    }
    if (await fetchHealth(apiBase, timeoutMs)) return;
    await sleep(delayMs);
  }
  const tail = readLogTail(logPath);
  throw new Error(
    `Host agent did not become healthy at ${apiBase}/api/health after ${attempts} attempts.${tail ? `\n${tail}` : ""}`,
  );
}

function defaultHostAgentArgs(repoRoot) {
  return [
    path.join(repoRoot, "packages", "app-core", "scripts", "run-node-tsx.mjs"),
    path.join(
      repoRoot,
      "packages",
      "app-core",
      "scripts",
      "serve-real-local-agent.ts",
    ),
  ];
}

function exitCodeForSignal(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

export async function startHostAgent({
  repoRoot = REPO_ROOT,
  host = DEFAULT_HOST_AGENT_HOST,
  port = resolveHostAgentRequestedPort(),
  preferredPort = DEFAULT_HOST_AGENT_PORT,
  logPath,
  command = process.execPath,
  args = defaultHostAgentArgs(repoRoot),
  env = process.env,
  log = () => {},
  signalSafe = true,
  healthAttempts = DEFAULT_HEALTH_ATTEMPTS,
  healthDelayMs = DEFAULT_HEALTH_DELAY_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
} = {}) {
  const selectedPort = await chooseHostAgentPort({
    requestedPort: port,
    preferredPort,
    host,
  });
  const apiBase = `http://${host}:${selectedPort}`;
  if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = logPath
    ? fs.createWriteStream(logPath, { flags: "a" })
    : null;
  const writeLog = (line) => {
    if (!logStream) return;
    logStream.write(`${line}\n`);
  };
  writeLog(`[host-agent-helper] starting ${apiBase}`);
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      ELIZA_API_PORT: String(selectedPort),
      ELIZA_PORT: String(selectedPort),
      ELIZA_PAIRING_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logStream ?? process.stdout);
  child.stderr?.pipe(logStream ?? process.stderr);

  let stopped = false;
  let exitInfo = null;
  let childError = null;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once("error", (error) => {
      childError = error;
      exitInfo = { code: null, signal: null, error };
      resolve(exitInfo);
    });
  });

  const signalHandlers = [];
  const stop = async (reason = "stop") => {
    if (stopped) return exitInfo;
    stopped = true;
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    writeLog(`[host-agent-helper] stopping (${reason})`);
    if (!exitInfo && child.exitCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => {
        if (!exitInfo && child.exitCode === null) child.kill("SIGKILL");
      }, 10_000);
      await exitPromise.finally(() => clearTimeout(timeout));
    }
    if (logStream) {
      await new Promise((resolve) => logStream.end(resolve));
    }
    return exitInfo;
  };

  if (signalSafe) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        void stop(signal).finally(() =>
          process.exit(exitCodeForSignal(signal)),
        );
      };
      process.once(signal, handler);
      signalHandlers.push([signal, handler]);
    }
  }

  try {
    await waitForHostAgentHealth({
      apiBase,
      child,
      getChildError: () => childError,
      logPath,
      attempts: healthAttempts,
      delayMs: healthDelayMs,
      timeoutMs: healthTimeoutMs,
    });
    log(`host agent ready at ${apiBase}`);
  } catch (error) {
    await stop("startup-failed");
    throw error;
  }

  return { apiBase, port: selectedPort, child, logPath, stop };
}
