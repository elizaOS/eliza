import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const DEFAULT_HOST_AGENT_PORT = 31338;
export const DEFAULT_HOST_AGENT_HOST = "127.0.0.1";
export const DEFAULT_HOST_AGENT_HEALTH_PATH = "/api/health";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const DEFAULT_READY_ATTEMPTS = 90;
const DEFAULT_READY_DELAY_MS = 2000;

export function parsePort(value, label = "port") {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return port;
}

export function hostAgentApiBase(port, host = DEFAULT_HOST_AGENT_HOST) {
  return `http://${host}:${port}`;
}

export async function isPortAvailable(port, host = DEFAULT_HOST_AGENT_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function chooseHostAgentPort({
  preferredPort = DEFAULT_HOST_AGENT_PORT,
  requestedPort = null,
  host = DEFAULT_HOST_AGENT_HOST,
} = {}) {
  if (requestedPort !== null && requestedPort !== undefined) {
    const port = parsePort(requestedPort, "host-agent port");
    if (!(await isPortAvailable(port, host))) {
      throw new Error(`Requested host-agent port ${port} is already in use.`);
    }
    return port;
  }

  const preferred = parsePort(preferredPort, "host-agent preferred port");
  if (await isPortAvailable(preferred, host)) return preferred;

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (typeof port === "number") resolve(port);
        else reject(new Error("Unable to allocate a free host-agent port."));
      });
    });
    server.listen(0, host);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailFile(filePath, maxBytes = 12_000) {
  try {
    const stats = fs.statSync(filePath);
    const start = Math.max(0, stats.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stats.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

async function waitForHealth({
  apiBase,
  child,
  getChildError,
  logPath,
  attempts,
  delayMs,
  log,
}) {
  const healthUrl = new URL(DEFAULT_HOST_AGENT_HEALTH_PATH, apiBase).toString();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const childError = getChildError?.();
    if (childError) {
      throw new Error(
        [`Host agent failed to start: ${childError.message}`, tailFile(logPath)]
          .filter(Boolean)
          .join("\n"),
      );
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        [
          `Host agent exited before ${healthUrl} became ready.`,
          tailFile(logPath),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        log?.(`host agent ready at ${apiBase}`);
        return;
      }
    } catch {
      // Retry until attempts are exhausted or the child exits.
    }

    await sleep(delayMs);
  }

  throw new Error(
    [
      `Timed out waiting for host agent health at ${healthUrl}.`,
      tailFile(logPath),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function startDeviceE2eHostAgent({
  repoRoot,
  artifactDir,
  requestedPort = null,
  preferredPort = process.env.ELIZA_IOS_HOST_AGENT_PORT ??
    DEFAULT_HOST_AGENT_PORT,
  host = DEFAULT_HOST_AGENT_HOST,
  readyAttempts = Number.parseInt(
    process.env.ELIZA_HOST_AGENT_READY_ATTEMPTS ??
      String(DEFAULT_READY_ATTEMPTS),
    10,
  ),
  readyDelayMs = Number.parseInt(
    process.env.ELIZA_HOST_AGENT_READY_DELAY_MS ??
      String(DEFAULT_READY_DELAY_MS),
    10,
  ),
  log = null,
  command = process.execPath,
  args = [
    path.join(repoRoot, "packages/app-core/scripts/run-node-tsx.mjs"),
    path.join(repoRoot, "packages/app-core/scripts/serve-real-local-agent.ts"),
  ],
  env = process.env,
} = {}) {
  if (!repoRoot) throw new Error("startDeviceE2eHostAgent requires repoRoot.");
  if (!artifactDir) {
    throw new Error("startDeviceE2eHostAgent requires artifactDir.");
  }

  const port = await chooseHostAgentPort({
    preferredPort,
    requestedPort,
    host,
  });
  const apiBase = hostAgentApiBase(port, host);
  fs.mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "host-agent.log");
  const logFd = fs.openSync(logPath, "w");
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...env,
      ELIZA_API_PORT: String(port),
      ELIZA_PAIRING_DISABLED: "1",
    },
    stdio: ["ignore", logFd, logFd],
  });
  let childError = null;
  let childExited = false;
  child.once("error", (error) => {
    childError = error;
  });
  child.once("exit", () => {
    childExited = true;
  });

  let stopped = false;
  let stopPromise = null;
  const stop = async () => {
    if (stopped) return stopPromise;
    stopped = true;
    stopPromise = new Promise((resolve) => {
      const finish = () => {
        try {
          fs.closeSync(logFd);
        } catch {
          // Already closed by the platform.
        }
        resolve();
      };

      if (
        child.pid === undefined ||
        childExited ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        finish();
        return;
      }

      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 10_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
      child.kill("SIGTERM");
    });
    return stopPromise;
  };

  const signalHandlers = new Map();
  for (const signal of SIGNALS) {
    const handler = () => {
      void stop().finally(() =>
        process.exit(
          128 + (signal === "SIGHUP" ? 1 : signal === "SIGINT" ? 2 : 15),
        ),
      );
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    log?.(`starting host agent at ${apiBase} (log: ${logPath})`);
    await waitForHealth({
      apiBase,
      child,
      getChildError: () => childError,
      logPath,
      attempts: readyAttempts,
      delayMs: readyDelayMs,
      log,
    });
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    apiBase,
    port,
    logPath,
    pid: child.pid,
    async stop() {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      await stop();
      log?.(`stopped host agent at ${apiBase}`);
    },
  };
}
