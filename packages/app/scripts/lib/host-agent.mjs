/**
 * Local device-e2e host-agent process helper. The child binds port 0 and
 * atomically advertises the live socket, avoiding probe-then-release races;
 * explicit caller ports remain strict. The helper waits for health and returns
 * the stop handle used by iOS/Android device lanes.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { waitForAdvertisedPort } from "../../../scripts/e2e-ports.mjs";

export const DEFAULT_HOST_AGENT_HOST = "127.0.0.1";
export const DEFAULT_HOST_AGENT_HEALTH_PATH = "/api/health";
export const DEFAULT_READY_ATTEMPTS = 90;
export const DEFAULT_READY_DELAY_MS = 2000;
export const DEFAULT_ADVERTISEMENT_POLL_INTERVAL_MS = 100;
/** Node clamps setTimeout delays above this value to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const activeSignalStops = new Set();
const sharedSignalHandlers = new Map();

function signalExitCode(signal) {
  return 128 + (signal === "SIGHUP" ? 1 : signal === "SIGINT" ? 2 : 15);
}

/** Coordinate all live children before honoring a parent termination signal. */
function registerSignalStop(stop) {
  activeSignalStops.add(stop);
  if (sharedSignalHandlers.size === 0) {
    for (const signal of SIGNALS) {
      const handler = () => {
        const stops = [...activeSignalStops];
        void Promise.allSettled(
          stops.map((activeStop) => activeStop()),
        ).finally(() => process.exit(signalExitCode(signal)));
      };
      sharedSignalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  return () => {
    activeSignalStops.delete(stop);
    if (activeSignalStops.size > 0) return;
    for (const [signal, handler] of sharedSignalHandlers) {
      process.off(signal, handler);
    }
    sharedSignalHandlers.clear();
  };
}

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
  const requirement =
    max === Number.MAX_SAFE_INTEGER
      ? "a non-negative safe integer"
      : `a non-negative safe integer no greater than ${max}`;
  const invalid = () =>
    new Error(
      `Invalid ${label}: expected ${requirement}; received ${JSON.stringify(value)}`,
    );
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
      throw invalid();
    }
    return value;
  }
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) {
    throw invalid();
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw invalid();
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

/**
 * Give port advertisement the same validated wall-clock budget as readiness.
 * A zero-delay readiness loop still receives one millisecond per attempt so
 * process startup is not converted into an immediate timeout.
 */
export function resolveAdvertisementWaitOptions({
  readyAttempts,
  readyDelayMs,
}) {
  const timeoutMs = readyAttempts * Math.max(readyDelayMs, 1);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      "Invalid host-agent readiness budget: readyAttempts * readyDelayMs must be a positive safe integer duration.",
    );
  }
  return {
    timeoutMs,
    pollIntervalMs: Math.min(DEFAULT_ADVERTISEMENT_POLL_INTERVAL_MS, timeoutMs),
  };
}

export function hostAgentApiBase(port, host = DEFAULT_HOST_AGENT_HOST) {
  return `http://${host}:${port}`;
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
  const advertisementWait = resolveAdvertisementWaitOptions(resolvedReady);

  const explicitPort =
    requestedPort === null || requestedPort === undefined
      ? null
      : parsePort(requestedPort, "host-agent port");
  fs.mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "host-agent.log");
  const portFile = path.join(
    artifactDir,
    `.host-agent-port-${process.pid}-${randomUUID()}`,
  );
  fs.rmSync(portFile, { force: true });
  const logFd = fs.openSync(logPath, "w");
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...env,
      ELIZA_API_PORT: String(explicitPort ?? 0),
      ELIZA_API_STRICT_PORT: "1",
      ELIZA_E2E_PORT_FILE: portFile,
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
        fs.rmSync(portFile, { force: true });
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

  const unregisterSignalStop = registerSignalStop(stop);

  try {
    const port = await Promise.race([
      waitForAdvertisedPort(portFile, { child, ...advertisementWait }),
      new Promise((_, reject) => {
        child.once("error", reject);
      }),
    ]);
    if (explicitPort !== null && port !== explicitPort) {
      throw new Error(
        `Host agent advertised port ${port}, expected explicit port ${explicitPort}.`,
      );
    }
    const apiBase = hostAgentApiBase(port, host);
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
    return {
      apiBase,
      port,
      logPath,
      pid: child.pid,
      async stop() {
        unregisterSignalStop();
        await stop();
        log?.(`stopped host agent at ${apiBase}`);
      },
    };
  } catch (error) {
    // error-policy:J2 stop child then rethrow readiness/spawn failure
    unregisterSignalStop();
    await stop();
    throw error;
  }
}
