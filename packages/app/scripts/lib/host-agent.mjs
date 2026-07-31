/**
 * Starts the real app-core agent used by device evidence lanes and owns its
 * port, readiness, logs, signal forwarding, and teardown lifecycle.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const DEFAULT_HOST_AGENT_PORT = 31338;
export const DEFAULT_HOST_AGENT_HOST = "127.0.0.1";
export const DEFAULT_HOST_AGENT_HEALTH_PATH = "/api/health";
export const LIVE_CEREBRAS_HOST_MODE = "live-cerebras";
export const LIVE_CEREBRAS_MODEL = "gemma-4-31b";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const DEFAULT_READY_DELAY_MS = 100;

/**
 * Build the explicit environment for device lanes that claim to exercise a
 * live Cerebras response and local voice inference. Requiring the bundle path
 * here prevents a missing asset from turning into a deterministic proxy run or
 * a skipped voice stage later in the workflow.
 */
export function liveCerebrasHostAgentEnv({ env = process.env } = {}) {
  const apiKey =
    env.CEREBRAS_API_KEY?.trim() || env.ELIZA_E2E_CEREBRAS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "CEREBRAS_API_KEY is required for the live device voice lane.",
    );
  }
  const bundlePath = env.ELIZA_E2E_LOCAL_VOICE_BUNDLE?.trim();
  if (!bundlePath || !path.isAbsolute(bundlePath)) {
    throw new Error(
      "ELIZA_E2E_LOCAL_VOICE_BUNDLE must be an absolute Eliza-1 bundle path.",
    );
  }

  return {
    ...env,
    CEREBRAS_API_KEY: apiKey,
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    ELIZA_PROVIDER: "cerebras",
    ELIZA_DEVICE_E2E_MODEL_MODE: LIVE_CEREBRAS_HOST_MODE,
    ELIZA_E2E_LOCAL_VOICE_BUNDLE: bundlePath,
    CEREBRAS_MODEL: LIVE_CEREBRAS_MODEL,
    CEREBRAS_SMALL_MODEL: LIVE_CEREBRAS_MODEL,
    CEREBRAS_LARGE_MODEL: LIVE_CEREBRAS_MODEL,
    OPENAI_SMALL_MODEL: LIVE_CEREBRAS_MODEL,
    OPENAI_MEDIUM_MODEL: LIVE_CEREBRAS_MODEL,
    OPENAI_LARGE_MODEL: LIVE_CEREBRAS_MODEL,
    OPENAI_RESPONSE_HANDLER_MODEL: LIVE_CEREBRAS_MODEL,
    OPENAI_ACTION_PLANNER_MODEL: LIVE_CEREBRAS_MODEL,
    OPENAI_PLANNER_MODEL: LIVE_CEREBRAS_MODEL,
    SMALL_MODEL: LIVE_CEREBRAS_MODEL,
    MEDIUM_MODEL: LIVE_CEREBRAS_MODEL,
    LARGE_MODEL: LIVE_CEREBRAS_MODEL,
    ACTION_PLANNER_MODEL: LIVE_CEREBRAS_MODEL,
    PLANNER_MODEL: LIVE_CEREBRAS_MODEL,
  };
}

/**
 * Select the host runtime. Local inference uses bun:ffi, so a live voice lane
 * must execute the TypeScript host directly with Bun; the Node+tsx runner is
 * retained for UI-only lanes that do not load native inference.
 */
export function resolveHostAgentProcess({
  repoRoot,
  env = process.env,
  nodeCommand = process.execPath,
} = {}) {
  if (!repoRoot) throw new Error("resolveHostAgentProcess requires repoRoot.");
  const serverPath = path.join(
    repoRoot,
    "packages/app-core/scripts/serve-real-local-agent.ts",
  );
  if (env.ELIZA_DEVICE_E2E_MODEL_MODE === LIVE_CEREBRAS_HOST_MODE) {
    return {
      command: env.ELIZA_BUN_PATH?.trim() || "bun",
      args: [serverPath],
    };
  }
  return {
    command: nodeCommand,
    args: [
      path.join(repoRoot, "packages/app-core/scripts/run-node-tsx.mjs"),
      serverPath,
    ],
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

function waitForRetryOrChild(child, getChildError, delayMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onChildStateChange);
      child.off("exit", onChildStateChange);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onChildStateChange = () => finish();
    const onAbort = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Host-agent startup was aborted by its owner."),
      );
    const timer = setTimeout(() => finish(), delayMs);
    timer.unref?.();
    child.once("error", onChildStateChange);
    child.once("exit", onChildStateChange);
    if (
      getChildError?.() ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      onChildStateChange();
    } else if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  delayMs,
  signal,
  log,
}) {
  const healthUrl = new URL(DEFAULT_HOST_AGENT_HEALTH_PATH, apiBase).toString();
  for (;;) {
    signal?.throwIfAborted();
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
      const response = await fetch(healthUrl, { signal });
      if (response.ok) {
        log?.(`host agent ready at ${apiBase}`);
        return;
      }
    } catch {
      signal?.throwIfAborted();
      // Connection refusal is expected while the local server is still booting.
    }

    await waitForRetryOrChild(child, getChildError, delayMs, signal);
  }
}

export async function startDeviceE2eHostAgent({
  repoRoot,
  artifactDir,
  requestedPort = null,
  preferredPort = process.env.ELIZA_IOS_HOST_AGENT_PORT ??
    DEFAULT_HOST_AGENT_PORT,
  host = DEFAULT_HOST_AGENT_HOST,
  readyDelayMs = Number.parseInt(
    process.env.ELIZA_HOST_AGENT_READY_DELAY_MS ??
      String(DEFAULT_READY_DELAY_MS),
    10,
  ),
  signal = undefined,
  log = null,
  command = null,
  args = null,
  env = process.env,
} = {}) {
  if (!repoRoot) throw new Error("startDeviceE2eHostAgent requires repoRoot.");
  if (!artifactDir) {
    throw new Error("startDeviceE2eHostAgent requires artifactDir.");
  }
  if (!Number.isFinite(readyDelayMs) || readyDelayMs <= 0) {
    throw new Error("readyDelayMs must be a positive number.");
  }
  const defaultProcess = resolveHostAgentProcess({ repoRoot, env });
  const resolvedCommand = command ?? defaultProcess.command;
  const resolvedArgs = args ?? defaultProcess.args;

  const port = await chooseHostAgentPort({
    preferredPort,
    requestedPort,
    host,
  });
  const apiBase = hostAgentApiBase(port, host);
  fs.mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "host-agent.log");
  const logFd = fs.openSync(logPath, "w");
  fs.writeSync(logFd, `[device-e2e-host-agent] starting on ${apiBase}\n`);
  const child = spawn(resolvedCommand, resolvedArgs, {
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
      delayMs: readyDelayMs,
      signal,
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
