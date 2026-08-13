/**
 * Local device-e2e host-agent process helper. Chooses an exclusive API port,
 * spawns the real local agent (or a caller-supplied command), waits for health,
 * and returns a stop handle used by iOS/Android device lanes.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const DEFAULT_HOST_AGENT_PORT = 31338;
export const DEFAULT_HOST_AGENT_HOST = "127.0.0.1";
export const DEFAULT_HOST_AGENT_HEALTH_PATH = "/api/health";
export const DEFAULT_READY_ATTEMPTS = 90;
export const DEFAULT_READY_DELAY_MS = 2000;
/** Node clamps setTimeout delays above this value to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

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

/**
 * Parses a non-negative safe integer from a string or number. Rejects partial
 * numeric strings (`10abc`), fractions, negatives, and empty values so readiness
 * knobs cannot silently become NaN/truncated via `Number.parseInt`.
 */
export function parseNonNegativeSafeInteger(value, label, options = {}) {
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
    return value;
  }
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

/** Like parseNonNegativeSafeInteger but requires a positive value (>= 1). */
export function parsePositiveSafeInteger(value, label) {
  const parsed = parseNonNegativeSafeInteger(value, label);
  if (parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

/**
 * Resolve readiness knobs from explicit options or env, failing closed on
 * malformed values so a typo never becomes a zero-iteration health wait.
 */
export function resolveReadyOptions(options = {}) {
  const { readyAttempts, readyDelayMs, env = process.env } = options;
  const hasReadyAttempts = Object.hasOwn(options, "readyAttempts");
  const hasReadyDelayMs = Object.hasOwn(options, "readyDelayMs");
  const attemptsOverride =
    hasReadyAttempts && readyAttempts !== undefined
      ? readyAttempts
      : (env.ELIZA_HOST_AGENT_READY_ATTEMPTS ?? null);
  const delayOverride =
    hasReadyDelayMs && readyDelayMs !== undefined
      ? readyDelayMs
      : (env.ELIZA_HOST_AGENT_READY_DELAY_MS ?? null);
  const isBlank = (value) =>
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "");
  const attemptsSource =
    hasReadyAttempts && readyAttempts !== undefined
      ? attemptsOverride
      : isBlank(attemptsOverride)
        ? DEFAULT_READY_ATTEMPTS
        : attemptsOverride;
  const delaySource =
    hasReadyDelayMs && readyDelayMs !== undefined
      ? delayOverride
      : isBlank(delayOverride)
        ? DEFAULT_READY_DELAY_MS
        : delayOverride;

  return {
    readyAttempts: parsePositiveSafeInteger(
      attemptsSource,
      "host-agent readyAttempts",
    ),
    readyDelayMs: parseNonNegativeSafeInteger(
      delaySource,
      "host-agent readyDelayMs",
      { max: MAX_TIMER_DELAY_MS },
    ),
  };
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
    // error-policy:J6 best-effort log tail for failure messages
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
      // error-policy:J4 health probe retry until attempts exhausted or child exits
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
  readyAttempts,
  readyDelayMs,
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

  // Validate before spawn so a bad env typo cannot start a child that is then
  // immediately torn down after a zero-iteration readiness wait. Readiness
  // knobs come from the parent process env (or explicit options), not the child
  // spawn env bag.
  const resolvedReady = resolveReadyOptions({
    readyAttempts,
    readyDelayMs,
    env: process.env,
  });

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
          // error-policy:J6 log fd may already be closed by the platform
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
      attempts: resolvedReady.readyAttempts,
      delayMs: resolvedReady.readyDelayMs,
      log,
    });
  } catch (error) {
    // error-policy:J2 stop child then rethrow readiness/spawn failure
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
