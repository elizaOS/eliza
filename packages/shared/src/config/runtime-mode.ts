import type { DeploymentTargetConfig } from "../contracts/service-routing.js";
import { normalizeDeploymentTargetConfig } from "../contracts/service-routing.js";
import { isPlainObject } from "../type-guards.js";

export const RUNTIME_EXECUTION_MODES = [
  "cloud",
  "local-safe",
  "local-yolo",
] as const;

export type RuntimeExecutionMode = (typeof RUNTIME_EXECUTION_MODES)[number];

export interface RuntimeModeConfig {
  executionMode?: RuntimeExecutionMode;
}

export interface RuntimeExecutionModeConfigSource {
  runtime?: RuntimeModeConfig | Record<string, unknown> | null;
  deploymentTarget?: DeploymentTargetConfig | null;
}

export interface RuntimeExecutionModeDefinition {
  mode: RuntimeExecutionMode;
  local: boolean;
  cloud: boolean;
  safe: boolean;
  yolo: boolean;
}

export const RUNTIME_EXECUTION_MODE_DEFINITIONS: Record<
  RuntimeExecutionMode,
  RuntimeExecutionModeDefinition
> = {
  cloud: {
    mode: "cloud",
    local: false,
    cloud: true,
    safe: true,
    yolo: false,
  },
  "local-safe": {
    mode: "local-safe",
    local: true,
    cloud: false,
    safe: true,
    yolo: false,
  },
  "local-yolo": {
    mode: "local-yolo",
    local: true,
    cloud: false,
    safe: false,
    yolo: true,
  },
};

export function normalizeRuntimeExecutionMode(
  value: unknown,
): RuntimeExecutionMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return RUNTIME_EXECUTION_MODES.includes(normalized as RuntimeExecutionMode)
    ? (normalized as RuntimeExecutionMode)
    : null;
}

export function isCloudRuntimeMode(value: unknown): boolean {
  return normalizeRuntimeExecutionMode(value) === "cloud";
}

export function isLocalRuntimeMode(value: unknown): boolean {
  const mode = normalizeRuntimeExecutionMode(value);
  return mode === "local-safe" || mode === "local-yolo";
}

export function isSafeLocalMode(value: unknown): boolean {
  return normalizeRuntimeExecutionMode(value) === "local-safe";
}

export function isYoloLocalMode(value: unknown): boolean {
  return normalizeRuntimeExecutionMode(value) === "local-yolo";
}

export function runtimeExecutionModeForDeploymentTarget(
  deploymentTarget: DeploymentTargetConfig | null | undefined,
): RuntimeExecutionMode {
  return deploymentTarget?.runtime === "cloud" ? "cloud" : "local-safe";
}

export function readRuntimeExecutionModeConfig(
  config: RuntimeExecutionModeConfigSource | null | undefined,
): RuntimeExecutionMode {
  const runtimeConfig = isPlainObject(config?.runtime)
    ? config.runtime
    : undefined;
  const explicitMode = normalizeRuntimeExecutionMode(
    runtimeConfig?.executionMode,
  );
  if (explicitMode) return explicitMode;

  return runtimeExecutionModeForDeploymentTarget(
    normalizeDeploymentTargetConfig(config?.deploymentTarget),
  );
}

/**
 * Structural shape for the runtime/setting source consumed by the env-driven
 * resolvers below. Kept structural so this module does not have to import
 * `IAgentRuntime` from `@elizaos/core` (which would create a layering wart —
 * runtime/agent types depend on this module, not the other way around).
 */
export interface RuntimeExecutionModeSource {
  getSetting?: (key: string) => unknown;
}

const RUNTIME_EXECUTION_MODE_SETTING_KEYS = [
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
] as const;

/**
 * Canonical resolver for the active runtime execution mode at the
 * agent/plugin boundary. Reads an explicit setting from the runtime first,
 * then falls back to the same env vars, defaulting to `local-yolo` when
 * nothing is set.
 *
 * This is the one source of truth for `cloud | local-safe | local-yolo`
 * routing; both the agent package and the shell/coding-tools plugins import
 * it from `@elizaos/shared` to avoid duplicating the resolution logic.
 */
export function resolveRuntimeExecutionMode(
  source?: RuntimeExecutionModeSource | null,
): RuntimeExecutionMode {
  for (const key of RUNTIME_EXECUTION_MODE_SETTING_KEYS) {
    const fromSetting = normalizeRuntimeExecutionMode(source?.getSetting?.(key));
    if (fromSetting) return fromSetting;
  }
  for (const key of RUNTIME_EXECUTION_MODE_SETTING_KEYS) {
    const fromEnv = normalizeRuntimeExecutionMode(process.env[key]);
    if (fromEnv) return fromEnv;
  }
  return "local-yolo";
}

/** Local-only narrowing of {@link RuntimeExecutionMode} for callers that only
 * distinguish local-safe vs local-yolo. Cloud collapses to `local-yolo` here
 * because legacy callers used this helper to pick a host-side execution path
 * and only flipped to safe-mode when the sandbox was required. */
export type LocalExecutionMode = "local-safe" | "local-yolo";

export function resolveLocalExecutionMode(
  source?: RuntimeExecutionModeSource | null,
): LocalExecutionMode {
  return resolveRuntimeExecutionMode(source) === "local-safe"
    ? "local-safe"
    : "local-yolo";
}

export function shouldUseSandboxExecution(
  source?: RuntimeExecutionModeSource | null,
): boolean {
  return resolveRuntimeExecutionMode(source) === "local-safe";
}

export function isCloudExecutionMode(
  source?: RuntimeExecutionModeSource | null,
): boolean {
  return resolveRuntimeExecutionMode(source) === "cloud";
}
