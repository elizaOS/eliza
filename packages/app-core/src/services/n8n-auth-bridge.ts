/**
 * n8n auth bridge — wires Eliza Cloud auth-state transitions to the local
 * n8n sidecar lifecycle.
 *
 * Motivation: when a user signs in to Eliza Cloud we route workflows
 * through the cloud gateway, so the local sidecar is dead weight (port
 * 5678, ~200MB RAM, a child Node/n8n process). When they sign out, we
 * want the local sidecar back — but only when `config.n8n.localEnabled`
 * is set and we are not running on a mobile shell (where no local
 * runtime exists).
 *
 * CLOUD_AUTH (from @elizaos/plugin-elizacloud) does not expose a native
 * observable; `isAuthenticated()` is read synchronously. We therefore
 * poll that method on a short interval and emit transitions. A 2s
 * debounce window guards against flap during init or token refresh.
 *
 * Lifecycle contract:
 *   - unauth → auth:
 *       if peekN8nSidecar() status is "starting" or "ready",
 *       call disposeN8nSidecar().
 *   - auth → unauth:
 *       if config.n8n.localEnabled and not mobile,
 *       call getN8nSidecar(resolvedConfig).start().
 *
 * This bridge never throws; subscription failures are logged and
 * swallowed so boot cannot be broken by sidecar lifecycle hiccups.
 */

import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  disposeN8nSidecar,
  getN8nSidecar,
  type N8nSidecarConfig,
  peekN8nSidecar,
} from "./n8n-sidecar";

/** Minimal shape of CLOUD_AUTH the bridge depends on. */
interface CloudAuthLike {
  isAuthenticated?: () => boolean;
}

/** Subset of ElizaConfig the bridge reads. */
export interface N8nAuthBridgeConfigLike {
  n8n?: {
    localEnabled?: boolean;
    version?: string;
    startPort?: number;
  };
}

export interface N8nAuthBridgeOptions {
  /** Poll interval in ms for auth state. Default 1000ms. */
  pollIntervalMs?: number;
  /** Debounce window in ms — ignore transitions flapping within this. Default 2000ms. */
  debounceMs?: number;
  /**
   * Report whether we are on a mobile (Capacitor native) shell. When true,
   * auth → unauth transitions do NOT spin up the local sidecar. Defaults
   * to `false` in a Node runtime (there is no mobile Node process today).
   */
  isMobile?: () => boolean;
  /**
   * Supplies the most recent config so localEnabled is read fresh at every
   * transition, not captured at bridge-start time. Without this the bridge
   * would miss a user toggling localEnabled mid-session.
   */
  getConfig?: () => N8nAuthBridgeConfigLike;
}

export interface N8nAuthBridgeHandle {
  /** Stop the poller. Idempotent. */
  stop: () => void;
  /**
   * Force-check the current auth state immediately (primarily for tests).
   * Returns the last-known auth state after evaluation.
   */
  poke: () => boolean;
}

function readCloudAuth(runtime: AgentRuntime | null): CloudAuthLike | null {
  if (!runtime || typeof runtime.getService !== "function") return null;
  const service = runtime.getService("CLOUD_AUTH");
  return service && typeof service === "object"
    ? (service as CloudAuthLike)
    : null;
}

function readIsAuthenticated(runtime: AgentRuntime | null): boolean {
  const auth = readCloudAuth(runtime);
  return Boolean(auth?.isAuthenticated?.());
}

function resolveSidecarConfig(cfg: N8nAuthBridgeConfigLike): N8nSidecarConfig {
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
 * Start an auth-state bridge that reacts to Eliza Cloud login/logout and
 * manages the local n8n sidecar accordingly.
 *
 * The caller owns lifetime — call `stop()` on shutdown.
 */
export function startN8nAuthBridge(
  runtime: AgentRuntime,
  config: N8nAuthBridgeConfigLike,
  options: N8nAuthBridgeOptions = {},
): N8nAuthBridgeHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const debounceMs = options.debounceMs ?? 2_000;
  const isMobile = options.isMobile ?? (() => false);
  const getConfig = options.getConfig ?? (() => config);

  let lastState = readIsAuthenticated(runtime);
  let lastTransitionAt = 0;
  let stopped = false;

  const handleTransition = (next: boolean): void => {
    const now = Date.now();
    if (lastTransitionAt > 0 && now - lastTransitionAt < debounceMs) {
      logger.debug(
        `[n8n-auth-bridge] ignoring transition ${lastState}→${next} (debounced ${now - lastTransitionAt}ms < ${debounceMs}ms)`,
      );
      return;
    }

    const prev = lastState;
    lastState = next;
    lastTransitionAt = now;

    if (prev === false && next === true) {
      const sidecar = peekN8nSidecar();
      const status = sidecar?.getState().status;
      if (sidecar && (status === "starting" || status === "ready")) {
        logger.info("[n8n] cloud authenticated — releasing local sidecar");
        void disposeN8nSidecar().catch((err: unknown) => {
          logger.warn(
            `[n8n-auth-bridge] disposeN8nSidecar failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
      return;
    }

    if (prev === true && next === false) {
      const cfg = getConfig();
      const localEnabled = cfg.n8n?.localEnabled ?? false;
      if (!localEnabled) return;
      if (isMobile()) return;
      logger.info("[n8n] cloud signed out — starting local sidecar");
      const sidecar = getN8nSidecar(resolveSidecarConfig(cfg));
      void sidecar.start().catch((err: unknown) => {
        logger.warn(
          `[n8n-auth-bridge] sidecar.start failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  };

  const tick = (): void => {
    if (stopped) return;
    const next = readIsAuthenticated(runtime);
    if (next !== lastState) handleTransition(next);
  };

  const timer = setInterval(tick, pollIntervalMs);
  // Don't keep the event loop alive just for this poller.
  if (
    typeof (timer as unknown as { unref?: () => void }).unref === "function"
  ) {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    poke: () => {
      tick();
      return lastState;
    },
  };
}
