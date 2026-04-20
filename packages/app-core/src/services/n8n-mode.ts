/**
 * Shared n8n mode resolution — cloud vs local vs disabled.
 *
 * Used by the HTTP routes to report state and by the autostart bridge to
 * decide whether to spawn the local sidecar at runtime boot. Keeping the
 * decision in one place ensures the UI status surface and the boot-time
 * spawn stay in lockstep.
 *
 * Desired mode is a pure function of:
 *   - cloud auth state (CLOUD_AUTH.isAuthenticated() or config.cloud.apiKey)
 *   - config.n8n.localEnabled
 *   - whether we are on a mobile (Capacitor) shell where the sidecar
 *     cannot run regardless of user setting
 */

import type { AgentRuntime } from "@elizaos/core";

export type N8nMode = "cloud" | "local" | "disabled";

/** Minimal cloud-auth shape the resolver reads. */
interface CloudAuthLike {
  isAuthenticated?: () => boolean;
}

/** Subset of the config this resolver cares about. */
export interface N8nModeConfigLike {
  cloud?: {
    enabled?: boolean;
    apiKey?: string;
  };
  n8n?: {
    localEnabled?: boolean;
  };
}

export interface ResolveN8nModeInput {
  config: N8nModeConfigLike;
  runtime: AgentRuntime | null;
  /**
   * True when the host is a Capacitor-native shell (iOS / Android). Mobile
   * cannot spawn the local sidecar because `node:child_process` is
   * unavailable; the user's `localEnabled` setting is ignored for mode
   * resolution in that environment.
   */
  native: boolean;
}

export interface ResolvedN8nMode {
  mode: N8nMode;
  /**
   * Effective localEnabled after the mobile override. `false` on mobile
   * regardless of the stored config.
   */
  localEnabled: boolean;
  cloudConnected: boolean;
}

/**
 * Returns true when a cloud session is usable for n8n. Mirrors the
 * semantics used by cloud-status-routes: a live CLOUD_AUTH service counts,
 * and a configured API key is accepted as a fallback even without a
 * runtime service (matches the dev path where the service is not yet
 * registered but credentials are present).
 */
export function isCloudConnected(
  config: N8nModeConfigLike,
  runtime: AgentRuntime | null,
): boolean {
  if (!config.cloud?.enabled) return false;
  const auth =
    runtime && typeof runtime.getService === "function"
      ? (runtime.getService("CLOUD_AUTH") as unknown as CloudAuthLike | null)
      : null;
  if (auth?.isAuthenticated?.()) return true;
  return Boolean(config.cloud.apiKey?.trim());
}

/**
 * Pure mode resolver. No side effects, no I/O — safe to call from any
 * context (route handler, autostart tick, status probe).
 */
export function resolveN8nMode(input: ResolveN8nModeInput): ResolvedN8nMode {
  const { config, runtime, native } = input;
  const cloudConnected = isCloudConnected(config, runtime);
  const localEnabled = native ? false : (config.n8n?.localEnabled ?? true);

  let mode: N8nMode;
  if (cloudConnected) {
    mode = "cloud";
  } else if (localEnabled) {
    mode = "local";
  } else {
    mode = "disabled";
  }

  return { mode, localEnabled, cloudConnected };
}
