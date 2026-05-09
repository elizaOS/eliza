/**
 * n8n autostart — boot-time sidecar spawn.
 *
 * Motivation: previously the local n8n sidecar was only spawned lazily
 * when the renderer opened the Workflows tab and POSTed
 * `/api/n8n/sidecar/start`. That meant the first workflow action paid
 * a cold-start tax (~10-20s of `bunx n8n@<pinned>`) and any scheduled
 * job that tried to dispatch a workflow before the user ever visited
 * the tab would fail. We now kick the sidecar off at agent boot when
 * the desired mode is "local".
 *
 * Desired state is computed via the shared `resolveN8nMode` helper:
 *   - mode === "local" AND no sidecar already spawned → start one.
 *   - otherwise → do nothing. The auth bridge owns the dispose-on-signin
 *     path; we do not stop anything here.
 *
 * Lifecycle contract:
 *   - First tick runs 50ms after `startN8nAutoStart()` returns so the
 *     caller (repairRuntimeAfterBoot) can finish the rest of its work
 *     without blocking on `bunx n8n` spawning.
 *   - Failures are caught and logged. The runtime must never fail boot
 *     because the n8n sidecar could not start.
 *   - `poke()` re-evaluates immediately — used after config hot-reload.
 *   - `stop()` is idempotent and cancels any pending first-tick timer.
 */

import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { isNativeServerPlatform } from "/shared";
import { type N8nModeConfigLike, resolveN8nMode } from "./n8n-mode.js";
import {
  getN8nSidecarAsync,
  type N8nSidecarConfig,
  peekN8nSidecar,
} from "./n8n-sidecar.js";

/**
 * Subset of ElizaConfig the autostart reads. Shares shape with the auth
 * bridge so the same loadElizaConfig() output feeds both.
 */
export interface N8nAutoStartConfigLike extends N8nModeConfigLike {
  n8n?: {
    localEnabled?: boolean;
    version?: string;
    startPort?: number;
  };
}

export interface N8nAutoStartOptions {
  /** Delay in ms before the first evaluation. Default 50ms. */
  initialDelayMs?: number;
  /**
   * Override the Capacitor-native detector. Default uses
   * `isNativeServerPlatform()`. Tests inject a deterministic value.
   */
  isMobile?: () => boolean;
  /**
   * Returns the most recent config — read fresh at each tick so hot
   * reloads land. Defaults to returning the config captured at start().
   */
  getConfig?: () => N8nAutoStartConfigLike;
  /**
   * Override the sidecar getter so tests can observe start calls without
   * spawning a real child process.
   */
  getSidecar?: (
    config: N8nSidecarConfig,
  ) => Promise<{ start: () => Promise<void> }>;
  /**
   * Override the singleton peek so tests can simulate the "already
   * spawned by a prior boot" hot-reload case without module state.
   */
  peekSidecar?: () => { getState(): { status: string } } | null;
  /**
   * setTimeout override for deterministic scheduling in tests.
   */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout override paired with `setTimer`. */
  clearTimer?: (handle: unknown) => void;
}

export interface N8nAutoStartHandle {
  /** Stop the autostart handle. Idempotent; cancels any pending first tick. */
  stop: () => Promise<void>;
  /** Force-evaluate desired state immediately. Used after config hot-reload. */
  poke: () => Promise<void>;
}

function resolveSidecarConfig(cfg: N8nAutoStartConfigLike): N8nSidecarConfig {
  const sidecar: N8nSidecarConfig = {
    enabled: cfg.n8n?.localEnabled ?? true,
  };
  if (cfg.n8n?.version) sidecar.version = cfg.n8n.version;
  if (typeof cfg.n8n?.startPort === "number") {
    sidecar.startPort = cfg.n8n.startPort;
  }
  return sidecar;
}

/**
 * Start the autostart handle. Returns a handle whose lifecycle the
 * caller owns. Never throws — failures to spawn log a warning and leave
 * the sidecar un-started so the UI can still fall back to the lazy
 * Workflows-tab path.
 */
export function startN8nAutoStart(
  runtime: AgentRuntime,
  config: N8nAutoStartConfigLike,
  options: N8nAutoStartOptions = {},
): N8nAutoStartHandle {
  const initialDelayMs = options.initialDelayMs ?? 50;
  const isMobile = options.isMobile ?? (() => isNativeServerPlatform());
  const getConfig = options.getConfig ?? (() => config);
  const getSidecar = options.getSidecar ?? getN8nSidecarAsync;
  const peekSidecar = options.peekSidecar ?? peekN8nSidecar;
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      (handle as unknown as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer =
    options.clearTimer ??
    ((handle) => {
      if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let stopped = false;
  let firstTickTimer: unknown = null;

  const evaluate = async (): Promise<void> => {
    if (stopped) return;
    const cfg = getConfig();
    const native = isMobile();
    const { mode } = resolveN8nMode({ config: cfg, runtime, native });

    if (mode !== "local") {
      logger.debug(
        `[n8n-autostart] desired mode=${mode} — skipping boot spawn`,
      );
      return;
    }

    // Hot-reload guard: a prior boot in this same process may have
    // already spawned the sidecar. Re-spawning would race the old
    // instance for port 5678 and leave two children behind.
    const existing = peekSidecar();
    const existingStatus = existing?.getState().status;
    if (
      existing &&
      (existingStatus === "starting" || existingStatus === "ready")
    ) {
      logger.debug(
        `[n8n-autostart] sidecar already ${existingStatus} — skipping boot spawn`,
      );
      return;
    }

    logger.info("[n8n] auto-starting local sidecar at boot");
    try {
      const sidecar = await getSidecar(resolveSidecarConfig(cfg));
      // Fire-and-forget: sidecar.start() resolves once the supervisor has
      // settled on starting/ready/error, which can take tens of seconds.
      // We must not block the boot on it.
      void sidecar.start().catch((err: unknown) => {
        logger.warn(
          `[n8n-autostart] boot start failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } catch (err) {
      logger.warn(
        `[n8n-autostart] boot start failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  firstTickTimer = setTimer(() => {
    firstTickTimer = null;
    void evaluate();
  }, initialDelayMs);

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (firstTickTimer !== null) {
        clearTimer(firstTickTimer);
        firstTickTimer = null;
      }
    },
    poke: async () => {
      if (stopped) return;
      // If the first tick hasn't fired yet, fold it into this poke so
      // callers don't double-evaluate.
      if (firstTickTimer !== null) {
        clearTimer(firstTickTimer);
        firstTickTimer = null;
      }
      await evaluate();
    },
  };
}
