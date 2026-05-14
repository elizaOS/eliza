import type { DeploymentTargetConfig } from "../contracts/service-routing.js";
import { normalizeDeploymentTargetConfig } from "../contracts/service-routing.js";
import { isPlainObject } from "../type-guards.js";
import {
  type DistributionProfile,
  isDistributionProfile,
} from "./distribution-profile.js";

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
  distributionProfile?: DistributionProfile | string | null;
  platform?: string | null;
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

export interface RuntimeExecutionModePolicyContext {
  deploymentTarget?: DeploymentTargetConfig | Record<string, unknown> | null;
  distributionProfile?: DistributionProfile | string | null;
  platform?: string | null;
  env?: Record<string, string | undefined> | null;
}

const RUNTIME_DISTRIBUTION_PROFILE_SETTING_KEYS = [
  "ELIZA_DISTRIBUTION_PROFILE",
] as const;

const RUNTIME_PLATFORM_SETTING_KEYS = ["ELIZA_PLATFORM"] as const;

function normalizeDistributionProfile(
  value: unknown,
): DistributionProfile | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isDistributionProfile(normalized) ? normalized : null;
}

function readSetting(
  source: RuntimeExecutionModeSource | null | undefined,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const value = source?.getSetting?.(key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function readEnv(
  env: Record<string, string | undefined> | null | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function resolvePolicyDistributionProfile(
  context?: RuntimeExecutionModePolicyContext | null,
  source?: RuntimeExecutionModeSource | null,
): DistributionProfile {
  return (
    normalizeDistributionProfile(context?.distributionProfile) ??
    normalizeDistributionProfile(
      readSetting(source, RUNTIME_DISTRIBUTION_PROFILE_SETTING_KEYS),
    ) ??
    normalizeDistributionProfile(
      readEnv(context?.env ?? process.env, RUNTIME_DISTRIBUTION_PROFILE_SETTING_KEYS),
    ) ??
    "unrestricted"
  );
}

function resolvePolicyPlatform(
  context?: RuntimeExecutionModePolicyContext | null,
  source?: RuntimeExecutionModeSource | null,
): string | null {
  const value =
    context?.platform ??
    readSetting(source, RUNTIME_PLATFORM_SETTING_KEYS) ??
    readEnv(context?.env ?? process.env, RUNTIME_PLATFORM_SETTING_KEYS);
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function isMobileRuntimePlatform(platform: string | null): boolean {
  return platform === "android" || platform === "ios";
}

export function canUseHostYoloRuntime(
  context?: RuntimeExecutionModePolicyContext | null,
  source?: RuntimeExecutionModeSource | null,
): boolean {
  const deploymentTarget = normalizeDeploymentTargetConfig(
    context?.deploymentTarget,
  );
  if (
    deploymentTarget?.runtime === "cloud" ||
    deploymentTarget?.runtime === "remote"
  ) {
    return false;
  }
  if (resolvePolicyDistributionProfile(context, source) === "store") {
    return false;
  }
  return !isMobileRuntimePlatform(resolvePolicyPlatform(context, source));
}

export function runtimeExecutionModeForPolicyContext(
  context?: RuntimeExecutionModePolicyContext | null,
  source?: RuntimeExecutionModeSource | null,
): RuntimeExecutionMode {
  const deploymentTarget = normalizeDeploymentTargetConfig(
    context?.deploymentTarget,
  );
  if (deploymentTarget) {
    return runtimeExecutionModeForDeploymentTarget(deploymentTarget);
  }
  return canUseHostYoloRuntime(context, source) ? "local-yolo" : "local-safe";
}

export function applyRuntimeExecutionModePolicy(
  requestedMode: RuntimeExecutionMode | null | undefined,
  context?: RuntimeExecutionModePolicyContext | null,
  source?: RuntimeExecutionModeSource | null,
): RuntimeExecutionMode {
  const deploymentTarget = normalizeDeploymentTargetConfig(
    context?.deploymentTarget,
  );
  if (deploymentTarget?.runtime === "cloud") return "cloud";
  if (!requestedMode) {
    return runtimeExecutionModeForPolicyContext(context, source);
  }
  if (requestedMode === "local-yolo" && !canUseHostYoloRuntime(context, source)) {
    return "local-safe";
  }
  return requestedMode;
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
  if (explicitMode) return applyRuntimeExecutionModePolicy(explicitMode, config);

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
  deploymentTarget?: DeploymentTargetConfig | Record<string, unknown> | null;
  distributionProfile?: DistributionProfile | string | null;
  platform?: string | null;
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
  context?: RuntimeExecutionModePolicyContext | null,
): RuntimeExecutionMode {
  for (const key of RUNTIME_EXECUTION_MODE_SETTING_KEYS) {
    const fromSetting = normalizeRuntimeExecutionMode(
      source?.getSetting?.(key),
    );
    if (fromSetting) {
      return applyRuntimeExecutionModePolicy(
        fromSetting,
        context ?? source ?? null,
        source,
      );
    }
  }
  for (const key of RUNTIME_EXECUTION_MODE_SETTING_KEYS) {
    const fromEnv = normalizeRuntimeExecutionMode(
      (context?.env ?? process.env)[key],
    );
    if (fromEnv) {
      return applyRuntimeExecutionModePolicy(
        fromEnv,
        context ?? source ?? null,
        source,
      );
    }
  }
  return runtimeExecutionModeForPolicyContext(context ?? source ?? null, source);
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
