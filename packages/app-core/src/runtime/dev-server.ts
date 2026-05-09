// Timing: Track when the script starts
const SCRIPT_START = Date.now();

import "@elizaos/shared";
import { getLogPrefix } from "@elizaos/shared";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "./error-handlers.js";
import { resolveRuntimeBootstrapFailure } from "./runtime-bootstrap-policy.js";

console.log(`${getLogPrefix()} Script starting...`);

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
import { setRestartHandler } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  colorizeDevSettingsStartupBanner,
  resolveApiToken,
  resolveDesktopApiPort,
  syncResolvedApiPort,
} from "@elizaos/shared";
import { ensureAuthPairingCodeForRemoteAccess } from "../api/auth-pairing-compat-routes";
import { startApiServer } from "../api/server";
import { formatApiDevSettingsBannerText } from "./api-dev-settings-banner.js";
import {
  attemptPgliteAutoReset,
  getPgliteRecoveryRetrySkipPlugins,
  shutdownRuntime,
  startEliza,
} from "./eliza";

console.log(
  `${getLogPrefix()} Imports complete (${Date.now() - SCRIPT_START}ms)`,
);

// Load .env files for parity with CLI mode (which loads via run-main.ts).
try {
  const { config } = await import("dotenv");
  config();
} catch {
  // dotenv not installed or .env not found — non-fatal.
}

console.log(`${getLogPrefix()} dotenv loaded (${Date.now() - SCRIPT_START}ms)`);

const port = resolveDesktopApiPort(process.env);
const hadUserApiTokenInEnv = !!process.env.ELIZA_API_TOKEN?.trim();

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
      logger.warn(
        `${getLogPrefix()} Failed to apply saved GitHub token (runtime continues without it): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const rt = await createRuntime();
    logger.info(
      `${getLogPrefix()} Runtime created in ${Date.now() - bootstrapStart}ms`,
    );
    const agentName = rt.character.name ?? "Eliza";

    if (isShuttingDown) {
      try {
        await shutdownRuntime(rt, "dev-server shutdown race");
      } catch {
        // Best effort during shutdown race.
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
    delete process.env.ELIZA_SKIP_PLUGINS;
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
  } catch (err) {
    if (!runtimeBootPgliteAutoResetAttempted) {
      try {
        const backupDir = await attemptPgliteAutoReset(err);
        if (backupDir) {
          runtimeBootPgliteAutoResetAttempted = true;
          runtimeBootAttempt = 0;
          runtimeBootFirstFailureAt = null;
          runtimeBootPgliteRecoverySkipPlugins =
            getPgliteRecoveryRetrySkipPlugins();
          if (runtimeBootPgliteRecoverySkipPlugins.length > 0) {
            process.env.ELIZA_SKIP_PLUGINS =
              runtimeBootPgliteRecoverySkipPlugins.join(",");
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
        logger.error(
          `${getLogPrefix()} PGlite auto-reset failed (${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr})`,
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
  if (currentRuntime) {
    try {
      await shutdownRuntime(currentRuntime, "dev-server createRuntime");
    } catch (err) {
      logger.warn(
        `${getLogPrefix()} Error stopping old runtime: ${err instanceof Error ? err.message : err}`,
      );
    }
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
  forceExitTimer.unref?.();

  logger.info(`${getLogPrefix()} Dev server shutting down…`);
  if (currentRuntime) {
    try {
      await shutdownRuntime(currentRuntime, "dev-server shutdown");
    } catch (err) {
      logger.warn(
        `${getLogPrefix()} Error stopping runtime during shutdown: ${err instanceof Error ? err.message : err}`,
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
    console.error(
      `${getLogPrefix()} [CRITICAL] API bound to port ${actualPort} but orchestrator expected ${port}. ` +
        `Electrobun renderer has ELIZA_DESKTOP_API_BASE pointing at the wrong port. ` +
        `Kill the process using port ${port} or set ELIZA_API_PORT to a free port.`,
    );
  }
  syncResolvedApiPort(process.env, actualPort);
  // Invalidate cached CORS port set so the new port is allowed.
  try {
    const { invalidateCorsAllowedPorts } = await import(
      "../api/server-cors.js"
    );
    invalidateCorsAllowedPorts();
  } catch {}
  // Use console.log for startup timing to bypass logger filtering
  console.log(
    `${getLogPrefix()} API server ready on port ${actualPort} (${apiReady - apiStart}ms)`,
  );

  const pairing = ensureAuthPairingCodeForRemoteAccess();

  // Print connection info
  const apiToken = resolveApiToken(process.env);
  console.log("");
  console.log(`${getLogPrefix()} ╭──────────────────────────────────────────╮`);
  console.log(`${getLogPrefix()} │  Server is running.                      │`);
  console.log(`${getLogPrefix()} │                                          │`);
  console.log(
    `${getLogPrefix()} │  Connect at: http://localhost:${String(actualPort).padEnd(13)}│`,
  );
  if (apiToken) {
    console.log(
      `${getLogPrefix()} │  Connection key: ${("*".repeat(Math.max(0, apiToken.length - 4)) + apiToken.slice(-4)).padEnd(22)}│`,
    );
  }
  if (pairing) {
    console.log(
      `${getLogPrefix()} │  Pairing code: ${pairing.code.padEnd(24)}│`,
    );
  }
  console.log(`${getLogPrefix()} ╰──────────────────────────────────────────╯`);
  console.log("");

  console.log(
    colorizeDevSettingsStartupBanner(
      formatApiDevSettingsBannerText(actualPort, {
        hadUserApiTokenInEnv,
      }),
    ),
  );

  // 2. Boot the elizaOS agent runtime without blocking server readiness.
  scheduleRuntimeBootstrap(0, "startup");

  console.log(
    `${getLogPrefix()} Startup init complete in ${Date.now() - startupStart}ms, agent bootstrapping...`,
  );
}

// ── Global error handlers (match CLI behavior from run-main.ts) ──
process.on("unhandledRejection", (reason) => {
  if (shouldIgnoreUnhandledRejection(reason)) {
    console.warn(
      `${getLogPrefix()} Provider credits appear exhausted; request failed without output. Top up credits and retry.`,
    );
    return;
  }
  // In dev mode (bun --watch), log but do NOT exit — let the watcher restart.
  console.error(
    `${getLogPrefix()} Unhandled rejection:`,
    formatUncaughtError(reason),
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    `${getLogPrefix()} Uncaught exception:`,
    formatUncaughtError(error),
  );
  process.exit(1);
});

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
