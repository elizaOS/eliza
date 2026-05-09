/**
 * Bridge from the agent runtime to the app-core n8n sidecar.
 *
 * The local n8n sidecar implementation lives at
 * `@elizaos/app-core/services/n8n-sidecar` (single source of truth: lifecycle,
 * REST-based owner setup, API-key provisioning, free-port picker, orphan
 * detection). The agent package can't statically import app-core (app-core
 * already depends on agent — it would be a cycle), so we dynamic-import
 * lazily here so the agent's `applyN8nConfigToEnv` can drive sidecar
 * readiness inline before the n8n plugin is loaded.
 *
 * Mobile platforms cannot spawn a child process; the caller must guard with
 * the platform check before invoking this bridge.
 *
 * @module n8n-sidecar-bridge
 */

import { logger } from "@elizaos/core";

const LOG_PREFIX = "[N8nSidecar]";

export interface SidecarBootResult {
  host: string;
  apiKey: string;
}

interface SidecarLike {
  start: () => Promise<void>;
  getState: () => {
    status: "stopped" | "starting" | "ready" | "error";
    host: string | null;
    errorMessage: string | null;
  };
  getApiKey: () => string | null;
  subscribe: (
    fn: (state: { status: "stopped" | "starting" | "ready" | "error" }) => void,
  ) => () => void;
}

interface SidecarModule {
  getN8nSidecarAsync: (config: {
    enabled?: boolean;
    version?: string;
    startPort?: number;
  }) => Promise<SidecarLike>;
  peekN8nSidecar: () => SidecarLike | null;
}

async function loadSidecarModule(): Promise<SidecarModule> {
  // Dynamic import: keeps app-core out of the agent package's static graph
  // (app-core already depends on @elizaos/agent — a static import here would
  // close the cycle). Same pattern is used elsewhere in this file for vault
  // services.
  const mod = (await import(
    "@elizaos/app-core"
  )) as SidecarModule;
  return mod;
}

export interface BootSidecarOptions {
  enabled?: boolean;
  version?: string;
  startPort?: number;
  /** Timeout in ms to wait for "ready" or "error". Default 60s. */
  readinessTimeoutMs?: number;
  /** Override the dynamic loader for tests. */
  loadModule?: () => Promise<SidecarModule>;
}

/**
 * Ensure the local n8n sidecar is ready, returning its host + apiKey.
 *
 * - If the sidecar is already `ready`, returns its current values without
 *   re-spawning.
 * - Otherwise starts the sidecar via `getN8nSidecarAsync().start()` and
 *   awaits the next `ready`/`error` transition (bounded by
 *   `readinessTimeoutMs`).
 * - Returns `null` if the sidecar lands in `error` or the timeout expires —
 *   the caller logs and falls through to "disabled" (the n8n plugin's
 *   init() will warn, which is the correct behavior when both cloud and
 *   local are unavailable).
 *
 * Caller must have already verified that the runtime is not on a mobile
 * platform; we do not re-check here.
 */
export async function bootLocalN8nSidecar(
  options: BootSidecarOptions = {},
): Promise<SidecarBootResult | null> {
  const loadModule = options.loadModule ?? loadSidecarModule;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;

  let mod: SidecarModule;
  try {
    mod = await loadModule();
  } catch (err) {
    logger.warn(
      `${LOG_PREFIX} failed to load sidecar module: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  const existing = mod.peekN8nSidecar();
  if (existing) {
    const state = existing.getState();
    if (state.status === "ready" && state.host) {
      const apiKey = existing.getApiKey();
      if (apiKey) {
        logger.info(`${LOG_PREFIX} Resolved via local-sidecar (already ready)`);
        return { host: state.host, apiKey };
      }
    }
  }

  let sidecar: SidecarLike;
  try {
    sidecar = await mod.getN8nSidecarAsync({
      enabled: options.enabled ?? true,
      version: options.version,
      startPort: options.startPort,
    });
  } catch (err) {
    logger.warn(
      `${LOG_PREFIX} failed to construct sidecar: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  // Kick start() in the background; await readiness via the subscription so
  // we don't block on the entire start() Promise (which only resolves once
  // the supervisor settles, but we want the first transition).
  void sidecar.start().catch((err: unknown) => {
    logger.debug(
      `${LOG_PREFIX} sidecar.start rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const ready = await new Promise<boolean>((resolve) => {
    const initial = sidecar.getState();
    if (initial.status === "ready") {
      resolve(true);
      return;
    }
    if (initial.status === "error") {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(ok);
    };
    const unsubscribe = sidecar.subscribe((s) => {
      if (s.status === "ready") settle(true);
      else if (s.status === "error") settle(false);
    });
    const timer = setTimeout(() => settle(false), readinessTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  if (!ready) {
    const state = sidecar.getState();
    logger.warn(
      `${LOG_PREFIX} sidecar did not reach ready (status=${state.status}${
        state.errorMessage ? `, ${state.errorMessage}` : ""
      })`,
    );
    return null;
  }

  const state = sidecar.getState();
  const apiKey = sidecar.getApiKey();
  if (!state.host || !apiKey) {
    logger.warn(
      `${LOG_PREFIX} sidecar reached ready but host/apiKey missing — host=${state.host ?? "null"}, apiKey=${apiKey ? "present" : "null"}`,
    );
    return null;
  }

  logger.info(`${LOG_PREFIX} Resolved via local-sidecar`);
  return { host: state.host, apiKey };
}
