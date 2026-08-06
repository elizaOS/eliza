/**
 * Combined dev-server / desktop-agent process entry. Binds the app-core API
 * server first (state "starting") so the dashboard can connect immediately,
 * then bootstraps the AgentRuntime in the background with retry + PGlite
 * corrupt-data auto-reset, hot-swaps the runtime on restart (RESTART_AGENT /
 * POST /api/agent/restart via setRestartHandler), and owns SIGINT/SIGTERM
 * graceful shutdown (startEliza runs headless and defers signal handling here).
 * Emits startup-timing plus RSS/heap instrumentation; timing anchors to a
 * parent-spawn env timestamp when present so logs include dependency import
 * time. The heavy ./eliza runtime graph is imported lazily to keep it out of the
 * eager import path before the API port binds.
 */
// Static ESM imports evaluate before this module body runs. Prefer a parent
// spawn timestamp so startup logs include dependency import/evaluation time.
const MODULE_BODY_START = Date.now();
const STARTUP_TIMESTAMP_ENV_KEYS = [
  "ELIZA_API_PROCESS_SPAWNED_AT_MS",
  "ELIZA_PROCESS_SPAWNED_AT_MS",
] as const;

function readStartupTimestampFromEnv(): { key: string; value: number } | null {
  for (const key of STARTUP_TIMESTAMP_ENV_KEYS) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      return { key, value };
    }
  }
  return null;
}

const STARTUP_TIMESTAMP = readStartupTimestampFromEnv();
const STARTUP_TIMING_START = STARTUP_TIMESTAMP?.value ?? MODULE_BODY_START;
const STARTUP_TIMING_SOURCE = STARTUP_TIMESTAMP
  ? `child-spawn env ${STARTUP_TIMESTAMP.key}`
  : "module-body timestamp";

function elapsedSinceStartupTimingStart(): number {
  return Date.now() - STARTUP_TIMING_START;
}

function elapsedSinceModuleBodyStart(): number {
  return Date.now() - MODULE_BODY_START;
}

import { colorizeDevSettingsStartupBanner } from "@elizaos/shared/dev-settings-banner-style";
import { formatError } from "@elizaos/shared/format-error";
import { setRestartHandler } from "@elizaos/shared/restart";
import {
  resolveApiToken,
  resolveDesktopApiPort,
  syncResolvedApiPort,
} from "@elizaos/shared/runtime-env";
import { getLogPrefix } from "@elizaos/shared/utils/log-prefix";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "./error-handlers.js";
import { resolveRuntimeBootstrapFailure } from "./runtime-bootstrap-policy.js";
import {
  mergedRecoverySkipPlugins,
  restoreOperatorSkipPlugins,
} from "./skip-plugins-env.js";

console.log(
  `${getLogPrefix()} Script starting... (timing: ${STARTUP_TIMING_SOURCE}; pre-body/import delay: ${
    STARTUP_TIMESTAMP
      ? `${Math.max(0, MODULE_BODY_START - STARTUP_TIMING_START)}ms`
      : "unavailable"
  })`,
);

/**
 * Combined dev server — starts the elizaOS runtime in headless mode and
 * wires it into the API server so the Control UI has a live agent to talk to.
 *
 * The ELIZA_HEADLESS env var tells startEliza() to skip the interactive
 * CLI chat loop and return the AgentRuntime instance.
 *
 * Usage: bun src/runtime/dev-server.ts   (with ELIZA_HEADLESS=1)
 *        (or via the dev script: bun run dev)
 */
import process from "node:process";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { ensureAuthPairingCodeForRemoteAccess } from "../api/auth-pairing-routes";
import { startApiServer } from "../api/server";
import {
  formatApiDevSettingsBannerText,
  shouldShowApiDevSettingsBanner,
} from "./api-dev-settings-banner.js";
import {
  isRoutineDevMemoryHeartbeatEnabled,
  logRoutineDevMemoryHeartbeat,
} from "./dev-memory-heartbeat.js";

/**
 * The `./eliza` module is the entire agent-runtime / startEliza graph
 * (`@elizaos/agent`, registry, app-route plugins, voice warmup, …). None of it
 * is needed to bind the API server or serve the health/listen path — it is only
 * used inside the runtime-bootstrap path, which runs *after* the API server is
 * listening. Importing it lazily keeps it out of the eager static import graph
 * that tsx must transpile + evaluate before the module body runs, shrinking the
 * pre-body/import delay before "API server ready".
 */
let elizaRuntimeModulePromise: Promise<typeof import("./eliza")> | null = null;
function loadElizaRuntimeModule(): Promise<typeof import("./eliza")> {
  if (!elizaRuntimeModulePromise) {
    elizaRuntimeModulePromise = import("./eliza");
  }
  return elizaRuntimeModulePromise;
}

console.log(
  `${getLogPrefix()} Static imports complete (${elapsedSinceStartupTimingStart()}ms since ${STARTUP_TIMING_SOURCE}; module body ${elapsedSinceModuleBodyStart()}ms)`,
);

// Load .env files for parity with CLI mode (which loads via run-main.ts).
const { config: loadDotenv } = await import("dotenv");
loadDotenv({ quiet: true });

console.log(
  `${getLogPrefix()} dotenv loaded (${elapsedSinceStartupTimingStart()}ms since ${STARTUP_TIMING_SOURCE}; module body ${elapsedSinceModuleBodyStart()}ms)`,
);

const port = resolveDesktopApiPort(process.env);
const hadUserApiTokenInEnv = !!resolveApiToken(process.env);

/** The currently active runtime — swapped on restart. */
let currentRuntime: AgentRuntime | null = null;

/** The API server's `updateRuntime` handle (set after startup). */
let apiUpdateRuntime: ((rt: AgentRuntime) => void) | null = null;
/** API server startup diagnostics updater (set after startup). */
let apiUpdateStartup:
  | ((update: {
      phase?: string;
      attempt?: number;
      lastError?: string;
      lastErrorAt?: number;
      nextRetryAt?: number;
      state?:
        | "not_started"
        | "starting"
        | "running"
        | "paused"
        | "stopped"
        | "restarting"
        | "error";
    }) => void)
  | null = null;

/** Guards against concurrent restart attempts (bun --watch + API restart). */
let isRestarting = false;

/** Tracks whether the process is shutting down to prevent restart during exit. */
let isShuttingDown = false;

/** Runtime bootstrap loop state (initial startup + retries). */
let runtimeBootAttempt = 0;
let runtimeBootInProgress = false;
let runtimeBootTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeBootFirstFailureAt: number | null = null;
let runtimeBootPgliteAutoResetAttempted = false;
let runtimeBootPgliteRecoverySkipPlugins: string[] = [];

// The operator's own ELIZA_SKIP_PLUGINS, captured before the PGlite-recovery
// retry ever touches the env var. The recovery path reuses the same variable
// to skip crash-implicated plugins on its one retry; without this capture,
// settling back after a successful boot would DELETE the operator's list, so
// any later in-process runtime re-bootstrap silently resurrected every
// operator-skipped plugin.
const operatorSkipPlugins = process.env.ELIZA_SKIP_PLUGINS;

function clearRuntimeBootTimer(): void {
  if (runtimeBootTimer) {
    clearTimeout(runtimeBootTimer);
    runtimeBootTimer = null;
  }
}

function scheduleRuntimeBootstrap(delayMs: number, reason: string): void {
  if (isShuttingDown) return;
  clearRuntimeBootTimer();
  runtimeBootTimer = setTimeout(
    () => {
      runtimeBootTimer = null;
      void bootstrapRuntime(reason);
    },
    Math.max(0, delayMs),
  );
}

async function bootstrapRuntime(reason: string): Promise<void> {
  if (isShuttingDown || isRestarting || runtimeBootInProgress) return;
  runtimeBootInProgress = true;
  const bootstrapStart = Date.now();
  const attempt = runtimeBootAttempt + 1;
  apiUpdateStartup?.({
    phase: "runtime-bootstrap",
    attempt,
    lastError: undefined,
    lastErrorAt: undefined,
    nextRetryAt: undefined,
    state: "starting",
  });

  try {
    logger.info(`${getLogPrefix()} Runtime bootstrap starting (${reason})`);

    // Apply the GitHub PAT saved via Settings → Coding Agents → GitHub
    // before the runtime loads. The orchestrator's existing
    // `runtime.getSetting("GITHUB_TOKEN")` resolution and any sub-agent
    // PTY session that shells out to `gh`/`git` both inherit the same
    // value from process.env once we set it here. Explicit shell-set
    // GITHUB_TOKEN always wins.
    try {
      const { applySavedTokenToEnv } = await import(
        "../services/github-credentials.js"
      );
      const result = await applySavedTokenToEnv();
      if (result.applied) {
        logger.info(
          `${getLogPrefix()} Applied saved GitHub token to runtime env (user=@${result.username})`,
        );
      } else if (result.envAlreadySet) {
        logger.info(
          `${getLogPrefix()} GITHUB_TOKEN already set in env — leaving untouched`,
        );
      }
    } catch (err) {
      // error-policy:J4 saved GitHub credentials are an optional convenience;
      // the warning makes the unavailable integration explicit to the owner.
      logger.warn(
        `${getLogPrefix()} Failed to apply saved GitHub token (runtime continues without it): ${formatError(err)}`,
      );
    }

    const rt = await createRuntime();
    logger.info(
      `${getLogPrefix()} Runtime created in ${Date.now() - bootstrapStart}ms`,
    );
    const agentName = rt.character.name ?? "Eliza";

    if (isShuttingDown) {
      try {
        const { shutdownRuntime } = await loadElizaRuntimeModule();
        await shutdownRuntime(rt, "dev-server shutdown race");
      } catch (error) {
        // error-policy:J6 shutdown won the startup race; teardown failure is
        // warned here but must not republish `rt`.
        logger.warn(
          `${getLogPrefix()} Runtime teardown failed during shutdown race: ${formatError(error)}`,
        );
      }
      return;
    }

    if (apiUpdateRuntime) {
      apiUpdateRuntime(rt);
    }
    runtimeBootAttempt = 0;
    runtimeBootFirstFailureAt = null;
    runtimeBootPgliteAutoResetAttempted = false;
    runtimeBootPgliteRecoverySkipPlugins = [];
    restoreOperatorSkipPlugins(operatorSkipPlugins);
    apiUpdateStartup?.({
      phase: "running",
      attempt: 0,
      lastError: undefined,
      lastErrorAt: undefined,
      nextRetryAt: undefined,
      state: "running",
    });
    logger.info(
      `${getLogPrefix()} Runtime ready — agent: ${agentName} (total: ${Date.now() - bootstrapStart}ms)`,
    );
    (await loadElizaRuntimeModule()).startDeferredLocalEmbeddingWarmup();
  } catch (err) {
    if (!runtimeBootPgliteAutoResetAttempted) {
      try {
        const { attemptPgliteAutoReset, getPgliteRecoveryRetrySkipPlugins } =
          await loadElizaRuntimeModule();
        const backupDir = await attemptPgliteAutoReset(err);
        if (backupDir) {
          runtimeBootPgliteAutoResetAttempted = true;
          runtimeBootAttempt = 0;
          runtimeBootFirstFailureAt = null;
          runtimeBootPgliteRecoverySkipPlugins =
            getPgliteRecoveryRetrySkipPlugins();
          if (runtimeBootPgliteRecoverySkipPlugins.length > 0) {
            process.env.ELIZA_SKIP_PLUGINS = mergedRecoverySkipPlugins(
              operatorSkipPlugins,
              runtimeBootPgliteRecoverySkipPlugins,
            );
            logger.warn(
              `${getLogPrefix()} Skipping previously failed plugins on the recovery retry: ${runtimeBootPgliteRecoverySkipPlugins.join(", ")}.`,
            );
          }
          apiUpdateStartup?.({
            phase: "runtime-bootstrap",
            attempt: 1,
            lastError: undefined,
            lastErrorAt: undefined,
            nextRetryAt: undefined,
            state: "starting",
          });
          logger.warn(
            `${getLogPrefix()} Quarantined corrupt PGlite data dir at ${backupDir}. Retrying runtime bootstrap once.`,
          );
          scheduleRuntimeBootstrap(0, "pglite-auto-reset");
          return;
        }
      } catch (recoveryErr) {
        // error-policy:J4 automatic quarantine is an optional recovery path;
        // failure falls through to the normal observable startup backoff.
        logger.error(
          `${getLogPrefix()} PGlite auto-reset failed (${formatError(recoveryErr)})`,
        );
      }
    }

    const now = Date.now();
    runtimeBootAttempt += 1;
    if (!runtimeBootFirstFailureAt) {
      runtimeBootFirstFailureAt = now;
    }
    const failure = resolveRuntimeBootstrapFailure({
      attempt: runtimeBootAttempt,
      err,
      firstFailureAt: runtimeBootFirstFailureAt,
      now,
    });
    apiUpdateStartup?.({
      phase: failure.phase,
      attempt: runtimeBootAttempt,
      lastError: failure.lastError,
      lastErrorAt: now,
      nextRetryAt: failure.nextRetryAt,
      state: failure.state,
    });
    if (failure.shouldRetry && failure.delayMs !== undefined) {
      logger.error(
        `${getLogPrefix()} Runtime bootstrap failed (${failure.lastError}). Retrying in ${Math.round(failure.delayMs / 1000)}s${failure.state === "error" ? " (UI state set to error)" : ""}`,
      );
      scheduleRuntimeBootstrap(failure.delayMs, "retry");
    } else {
      logger.error(
        `${getLogPrefix()} Runtime bootstrap failed (${failure.lastError}). Startup halted until the PGlite issue is fixed.`,
      );
    }
  } finally {
    runtimeBootInProgress = false;
  }
}

/**
 * Create a fresh runtime via startEliza (headless).
 * If a runtime is already running, stop it first.
 */
async function createRuntime(): Promise<AgentRuntime> {
  const { shutdownRuntime, startEliza } = await loadElizaRuntimeModule();
  if (currentRuntime) {
    await shutdownRuntime(currentRuntime, "dev-server createRuntime");
    currentRuntime = null;
  }

  const result = await startEliza({ headless: true });
  if (!result) {
    throw new Error("startEliza returned null — runtime failed to initialize");
  }

  currentRuntime = result as AgentRuntime;
  return currentRuntime;
}

let restartPromise: Promise<void> | null = null;

async function handleRestart(reason?: string): Promise<void> {
  if (isShuttingDown) {
    throw new Error("Restart skipped — process is shutting down");
  }

  if (restartPromise) {
    logger.info(
      `${getLogPrefix()} Restart already in progress, awaiting existing restart...`,
    );
    return restartPromise;
  }

  restartPromise = (async () => {
    isRestarting = true;
    try {
      clearRuntimeBootTimer();
      if (runtimeBootInProgress) {
        throw new Error(
          "Restart requested while runtime bootstrap is in progress. Please wait for startup to complete.",
        );
      }

      logger.info(
        `${getLogPrefix()} Restart requested${reason ? ` (${reason})` : ""} — bouncing runtime…`,
      );
      apiUpdateStartup?.({
        phase: "runtime-restart",
        attempt: 0,
        lastError: undefined,
        lastErrorAt: undefined,
        nextRetryAt: undefined,
        state: "starting",
      });

      const rt = await createRuntime();
      const agentName = rt.character.name ?? "Eliza";
      logger.info(`${getLogPrefix()} Runtime restarted — agent: ${agentName}`);

      // Hot-swap the API server's runtime reference.
      if (apiUpdateRuntime) {
        apiUpdateRuntime(rt);
      }
    } finally {
      isRestarting = false;
      restartPromise = null;
    }
  })();

  return restartPromise;
}

/**
 * Graceful shutdown for the dev-server process.
 *
 * Since we told startEliza to run in headless mode (which now skips
 * registering its own SIGINT/SIGTERM handlers), we own the shutdown
 * lifecycle here.
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearRuntimeBootTimer();

  // Force exit if graceful shutdown hangs for more than 10 seconds.
  const forceExitTimer = setTimeout(() => {
    logger.warn(
      `${getLogPrefix()} Shutdown timed out after 10s — forcing exit`,
    );
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  logger.info(`${getLogPrefix()} Dev server shutting down…`);
  if (currentRuntime) {
    try {
      // currentRuntime is only ever set inside createRuntime(), which has
      // already loaded the eliza module — so this resolves the cached promise.
      const { shutdownRuntime } = await loadElizaRuntimeModule();
      await shutdownRuntime(currentRuntime, "dev-server shutdown");
    } catch (err) {
      // error-policy:J6 the process boundary is already shutting down and a
      // forced-exit timer guarantees completion after this warning.
      logger.warn(
        `${getLogPrefix()} Error stopping runtime during shutdown: ${formatError(err)}`,
      );
    }
    currentRuntime = null;
  }
  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function main() {
  const startupStart = Date.now();

  // Register the in-process restart handler so the RESTART_AGENT action
  // (and the POST /api@elizaos/agent/restart endpoint) work without killing the
  // process.
  setRestartHandler(handleRestart);

  // 1. Start the API server first (no runtime yet) so the UI can connect
  //    immediately while the heavier agent runtime boots in the background.
  const apiStart = Date.now();
  const {
    port: actualPort,
    updateRuntime,
    updateStartup,
  } = await startApiServer({
    port,
    initialAgentState: "starting",
    onRestart: async () => {
      await handleRestart("api");
      return currentRuntime;
    },
  });
  apiUpdateRuntime = updateRuntime;
  apiUpdateStartup = updateStartup;
  apiUpdateStartup({
    phase: "api-ready",
    attempt: 0,
    lastError: undefined,
    lastErrorAt: undefined,
    nextRetryAt: undefined,
    state: "starting",
  });
  const apiReady = Date.now();
  // WHY sync API vars only: under `dev:desktop`, dev-platform sets ELIZA_PORT to
  // the **Vite** listen port for `/api/dev/stack` + static HTML hints, while
  // ELIZA_API_PORT is the app API. Overwriting ELIZA_PORT here would
  // collapse UI vs API in observability JSON and confuse tools that read env.
  if (actualPort !== port) {
    logger.error(
      `${getLogPrefix()} [CRITICAL] API bound to port ${actualPort} but orchestrator expected ${port}. ` +
        `Electrobun renderer has ELIZA_DESKTOP_API_BASE pointing at the wrong port. ` +
        `Kill the process using port ${port} or set ELIZA_API_PORT to a free port.`,
    );
  }
  syncResolvedApiPort(process.env, actualPort);

  // Boot the elizaOS agent runtime without blocking server readiness. Scheduled
  // here — before the CORS dynamic import and the cosmetic banner/pairing block
  // below — because `scheduleRuntimeBootstrap` only queues a macrotask: the lone
  // event-loop yield in the remaining startup tail is the `await import` of
  // server-cors, so queueing the bootstrap first lets `createRuntime()` begin
  // during that import (the measured win under host contention). The runtime
  // needs seconds to become ready, so the synchronous CORS-allowlist
  // invalidation and pairing-code setup that follow still complete long before
  // any cross-origin request can reach the agent. The resolved API port is
  // already synced into env above, so the runtime reads the correct port.
  scheduleRuntimeBootstrap(0, "startup");

  // Invalidate cached CORS port set so the new port is allowed.
  const { invalidateCorsAllowedPorts } = await import("../api/server-cors.js");
  invalidateCorsAllowedPorts();
  const pairing = ensureAuthPairingCodeForRemoteAccess();

  // Keep the default ready signal compact. Credential and pairing details are
  // separate because they are conditional and operationally necessary.
  const apiToken = resolveApiToken(process.env);
  console.log(
    `${getLogPrefix()} API ready: http://localhost:${actualPort} (${apiReady - apiStart}ms)`,
  );
  if (apiToken) {
    console.log(
      `${getLogPrefix()} Connection key: ${"*".repeat(Math.max(0, apiToken.length - 4)) + apiToken.slice(-4)}`,
    );
  }
  if (pairing) {
    console.log(`${getLogPrefix()} Pairing code: ${pairing.code}`);
  }

  if (shouldShowApiDevSettingsBanner(process.env)) {
    console.log(
      colorizeDevSettingsStartupBanner(
        formatApiDevSettingsBannerText(actualPort, {
          hadUserApiTokenInEnv,
        }),
      ),
    );
  }

  console.log(
    `${getLogPrefix()} Startup init complete in ${Date.now() - startupStart}ms, agent bootstrapping...`,
  );
}

// ── Global error handlers (match CLI behavior from run-main.ts) ──
process.on("unhandledRejection", (reason) => {
  if (shouldIgnoreUnhandledRejection(reason)) {
    logger.warn(
      `${getLogPrefix()} Provider credits appear exhausted; request failed without output. Top up credits and retry.`,
    );
    return;
  }
  // In dev mode (bun --watch), log but do NOT exit — let the watcher restart.
  logger.error(
    `${getLogPrefix()} Unhandled rejection: ${formatUncaughtError(reason)}`,
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    `${getLogPrefix()} Uncaught exception:`,
    formatUncaughtError(error),
  );
  process.exit(1);
});

// ── Dev memory instrumentation ──────────────────────────────────────
// Agents cannot see the native window; surface RSS/heap so a runaway child
// (a stuck boot was observed climbing 399MB→1.8GB over minutes) is visible in
// the debug log and correlatable with restart events. Forced collection can
// pause the process, so this diagnostic is opt-in. .unref() prevents it from
// holding the process open.
if (isRoutineDevMemoryHeartbeatEnabled(process.env.ELIZA_DEV_HEAP_REPORT)) {
  const heapReportTimer = setInterval(() => {
    // --expose-gc (set by dev-ui) lets us report post-collection RETAINED heap,
    // which separates a real leak from uncollected garbage. rss stays the
    // headline runaway signal either way.
    if (typeof global.gc === "function") {
      global.gc();
    }
    logRoutineDevMemoryHeartbeat(logger, getLogPrefix(), process.memoryUsage());
  }, 60_000);
  heapReportTimer.unref();
}

main().catch((err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(`${getLogPrefix()} Fatal error:`, error.stack ?? error.message);
  if (error.cause) {
    const cause =
      error.cause instanceof Error
        ? error.cause
        : new Error(String(error.cause));
    console.error(`${getLogPrefix()} Caused by:`, cause.stack ?? cause.message);
  }
  process.exit(1);
});
