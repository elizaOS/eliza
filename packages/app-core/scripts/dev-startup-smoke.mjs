#!/usr/bin/env node
/**
 * CI smoke: boot `bun run dev` and assert the full dev stack reaches a usable
 * state (API runtime ready AND Vite UI serving) within a hard time budget.
 * Exits non-zero if the budget is exceeded or the dev process dies.
 *
 * Runs on freshly-allocated ports and a throwaway state dir so it never
 * collides with a developer's running dev server or mutates ~/.eliza.
 *
 * Env timing knobs must be complete positive safe-integer decimals. Bare
 * `Number(...)` previously turned typos into NaN, and `Date.now() > NaN` is
 * always false, so a bad `ELIZA_DEV_STARTUP_BUDGET_MS` could hang the smoke
 * forever instead of failing closed before spawn.
 *
 * Env:
 *   ELIZA_DEV_STARTUP_BUDGET_MS     hard ceiling, default 60000
 *   ELIZA_DEV_STARTUP_HARD_KILL_MS  grace before SIGKILL on teardown, default 8000
 *                                   (capped at Node's max timer delay)
 *
 * Emits one compact machine-readable line prefixed with:
 *   [dev-startup-smoke:metrics]
 */

import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { signalSpawnedProcessTree } from "./lib/kill-process-tree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/** Default hard ceiling for the full stack reaching ready (1 minute gate). */
export const DEFAULT_BUDGET_MS = 60_000;

/** Default SIGTERM→SIGKILL grace during teardown. */
export const DEFAULT_HARD_KILL_MS = 8_000;

/** Node clamps `setTimeout` delays above this to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Accept only complete positive safe-integer decimal strings (or numbers).
 * Rejects partial numbers, padded tokens, signed values, fractions, zero, and
 * values above an optional max (defaults to Number.MAX_SAFE_INTEGER).
 * @param {string | number} value
 * @param {string} label
 * @param {{ max?: number }} [options]
 * @returns {number}
 */
export function parsePositiveSafeInteger(value, label, options = {}) {
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const rangeHint =
    max === Number.MAX_SAFE_INTEGER
      ? "a positive safe-integer decimal"
      : `a positive safe-integer decimal from 1 to ${max}`;
  const received = (v) =>
    typeof v === "number" ? JSON.stringify(v) : JSON.stringify(String(v ?? ""));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new Error(
        `${label} must be ${rangeHint} (received ${received(value)})`,
      );
    }
    return value;
  }
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be ${rangeHint} (received ${received(value)})`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > max ||
    String(parsed) !== raw
  ) {
    throw new Error(
      `${label} must be ${rangeHint} (received ${received(value)})`,
    );
  }
  return parsed;
}

/**
 * Resolve budget and hard-kill timing from env. Unset/empty/whitespace keep
 * historical defaults. Explicit overrides fail closed on typos.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ budgetMs: number, hardKillMs: number }}
 */
export function resolveStartupSmokeTiming(env = process.env) {
  const budgetRaw = env.ELIZA_DEV_STARTUP_BUDGET_MS;
  const hardKillRaw = env.ELIZA_DEV_STARTUP_HARD_KILL_MS;

  const budgetMs =
    budgetRaw == null || String(budgetRaw).trim() === ""
      ? DEFAULT_BUDGET_MS
      : parsePositiveSafeInteger(budgetRaw, "ELIZA_DEV_STARTUP_BUDGET_MS");

  const hardKillMs =
    hardKillRaw == null || String(hardKillRaw).trim() === ""
      ? DEFAULT_HARD_KILL_MS
      : parsePositiveSafeInteger(
          hardKillRaw,
          "ELIZA_DEV_STARTUP_HARD_KILL_MS",
          { max: MAX_TIMER_DELAY_MS },
        );

  return { budgetMs, hardKillMs };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`port ${port} never opened`));
        return;
      }
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function waitForAgentReady(port, deadline) {
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok && (await res.json())?.ready === true) return;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API /api/health.ready never reported true on port ${port}`);
}

async function waitForUiServing(port, deadline) {
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.text();
        if (body.length > 0) return;
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite UI never served HTML on port ${port}`);
}

/**
 * @param {{ budgetMs: number, hardKillMs: number }} timing
 */
async function main(timing) {
  const { budgetMs: BUDGET_MS, hardKillMs: HARD_KILL_MS } = timing;
  const apiPort = await getFreePort();
  let uiPort = await getFreePort();
  if (uiPort === apiPort) uiPort = await getFreePort();
  const stateDir = path.join(
    os.tmpdir(),
    `eliza-dev-startup-smoke-${process.pid}-${Date.now()}`,
  );

  console.log(
    `[dev-startup-smoke] budget=${BUDGET_MS}ms api=${apiPort} ui=${uiPort}`,
  );

  const metrics = {
    status: "running",
    budgetMs: BUDGET_MS,
    ports: {
      api: apiPort,
      ui: uiPort,
    },
    milestonesMs: {
      processSpawn: null,
      apiListen: null,
      healthReady: null,
      uiServed: null,
      total: null,
    },
    segmentsMs: {
      processSpawnToApiListen: null,
      apiListenToHealthReady: null,
      processSpawnToUiServed: null,
    },
  };

  let start = 0;
  const elapsedMs = () => Date.now() - start;
  const markMilestone = (name, label) => {
    if (metrics.milestonesMs[name] !== null) return metrics.milestonesMs[name];
    const elapsed = elapsedMs();
    metrics.milestonesMs[name] = elapsed;
    console.log(`[dev-startup-smoke] ${label}: ${elapsed}ms`);
    return elapsed;
  };
  const finalizeMetrics = (status, error) => {
    metrics.status = status;
    metrics.milestonesMs.total = elapsedMs();
    const { processSpawn, apiListen, healthReady, uiServed } =
      metrics.milestonesMs;
    if (processSpawn !== null && apiListen !== null) {
      metrics.segmentsMs.processSpawnToApiListen = apiListen - processSpawn;
    }
    if (apiListen !== null && healthReady !== null) {
      metrics.segmentsMs.apiListenToHealthReady = healthReady - apiListen;
    }
    if (processSpawn !== null && uiServed !== null) {
      metrics.segmentsMs.processSpawnToUiServed = uiServed - processSpawn;
    }
    if (error) metrics.error = error;
    console.log(`[dev-startup-smoke:metrics] ${JSON.stringify(metrics)}`);
  };

  start = Date.now();
  const child = spawn("bun", ["run", "dev"], {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CI: "true",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_UI_PORT: String(uiPort),
      ELIZA_PORT: String(uiPort),
      ELIZA_STATE_DIR: stateDir,
      ELIZA_NAMESPACE: "eliza-dev-startup-smoke",
      ELIZA_DEV_NO_WATCH: "1",
      ELIZA_DEV_QUIET_LOGS: "1",
      ELIZA_NO_VISION_DEPS: "1",
      FORCE_COLOR: "0",
      NODE_NO_WARNINGS: "1",
    },
  });
  markMilestone("processSpawn", "process spawned");

  let exitedEarly = null;
  child.on("exit", (code, signal) => {
    exitedEarly = signal ? `signal ${signal}` : `code ${code}`;
  });

  const teardown = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || exitedEarly) return resolve();
      signalSpawnedProcessTree(child, "SIGTERM");
      const t = setTimeout(() => {
        signalSpawnedProcessTree(child, "SIGKILL");
        resolve();
      }, HARD_KILL_MS);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });

  const deadline = start + BUDGET_MS;

  // Race readiness against the process dying or the budget elapsing.
  const diedOrTimedOut = new Promise((_, reject) => {
    const timer = setInterval(() => {
      if (exitedEarly) {
        clearInterval(timer);
        reject(new Error(`dev process exited early (${exitedEarly})`));
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(
          new Error(
            `startup exceeded budget of ${BUDGET_MS}ms (${((Date.now() - start) / 1000).toFixed(1)}s)`,
          ),
        );
      }
    }, 200);
  });

  try {
    await Promise.race([
      Promise.all([
        waitForPort(apiPort, deadline)
          .then(() => markMilestone("apiListen", "API listen"))
          .then(() => waitForAgentReady(apiPort, deadline))
          .then(() => markMilestone("healthReady", "/api/health.ready")),
        waitForPort(uiPort, deadline)
          .then(() => waitForUiServing(uiPort, deadline))
          .then(() => markMilestone("uiServed", "UI served")),
      ]),
      diedOrTimedOut,
    ]);
  } catch (err) {
    finalizeMetrics("fail", err.message);
    await teardown();
    console.error(`[dev-startup-smoke] FAIL: ${err.message}`);
    process.exit(1);
  }

  const elapsed = Date.now() - start;
  finalizeMetrics("pass");
  await teardown();
  console.log(
    `[dev-startup-smoke] PASS: dev stack ready in ${(elapsed / 1000).toFixed(1)}s (budget ${(BUDGET_MS / 1000).toFixed(0)}s)`,
  );
  process.exit(0);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  let timing;
  try {
    timing = resolveStartupSmokeTiming(process.env);
  } catch (error) {
    // error-policy:J1 CLI boundary — invalid timing env fails before port
    // allocation or `bun run dev` spawn, so a typo cannot hang the CI job.
    console.error(
      error instanceof Error
        ? error.message
        : "[dev-startup-smoke] invalid timing environment",
    );
    process.exit(1);
  }
  main(timing).catch((err) => {
    console.error(`[dev-startup-smoke] unexpected error: ${err?.stack || err}`);
    process.exit(1);
  });
}
