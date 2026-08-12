/**
 * Frozen iOS build-target policies and their resolved build environments.
 * Named targets own runtime and engine compatibility so package commands,
 * renderer stamps, native payload staging, and tests share one decision.
 */
import { ElizaError } from "../../lib/eliza-error.mjs";

/**
 * @typedef {"operator-default" | "target"} IosEnvironmentAuthority
 * @typedef {{ target: string, capacitorTarget: "ios", buildVariant: "store" | "direct",
 *   releaseAuthority: "apple-app-store" | "developer-toolchain",
 *   iosRuntimeMode: "cloud" | "cloud-hybrid" | "local",
 *   runtimeExecutionMode: "cloud" | "local-safe",
 *   environmentAuthority: IosEnvironmentAuthority,
 *   localEngine: "required" | "allowed" | "forbidden",
 *   includeLlama: "disabled" | "direct-default",
 *   appControlledOta: false }} IosBuildTarget
 */

/** @param {IosBuildTarget} target */
function freezeIosBuildTarget(target) {
  return Object.freeze({ ...target });
}

/** @type {Readonly<Record<string, IosBuildTarget>>} */
export const IOS_BUILD_TARGETS = Object.freeze({
  ios: freezeIosBuildTarget({
    target: "ios",
    capacitorTarget: "ios",
    buildVariant: "store",
    releaseAuthority: "apple-app-store",
    iosRuntimeMode: "cloud-hybrid",
    runtimeExecutionMode: "local-safe",
    environmentAuthority: "operator-default",
    localEngine: "allowed",
    includeLlama: "disabled",
    appControlledOta: false,
  }),
  "ios-cloud": freezeIosBuildTarget({
    target: "ios-cloud",
    capacitorTarget: "ios",
    buildVariant: "store",
    releaseAuthority: "apple-app-store",
    iosRuntimeMode: "cloud",
    runtimeExecutionMode: "cloud",
    environmentAuthority: "target",
    localEngine: "forbidden",
    includeLlama: "disabled",
    appControlledOta: false,
  }),
  "ios-local": freezeIosBuildTarget({
    target: "ios-local",
    capacitorTarget: "ios",
    buildVariant: "direct",
    releaseAuthority: "developer-toolchain",
    iosRuntimeMode: "local",
    runtimeExecutionMode: "local-safe",
    environmentAuthority: "operator-default",
    localEngine: "required",
    includeLlama: "direct-default",
    appControlledOta: false,
  }),
  "ios-overlay": freezeIosBuildTarget({
    target: "ios-overlay",
    capacitorTarget: "ios",
    buildVariant: "direct",
    releaseAuthority: "developer-toolchain",
    iosRuntimeMode: "cloud",
    runtimeExecutionMode: "cloud",
    environmentAuthority: "operator-default",
    localEngine: "allowed",
    includeLlama: "disabled",
    appControlledOta: false,
  }),
});

/** @param {string} targetName @returns {IosBuildTarget} */
export function resolveIosBuildTargetPolicy(targetName) {
  if (!Object.hasOwn(IOS_BUILD_TARGETS, targetName)) {
    throw new ElizaError(
      `[mobile-build] Unknown iOS build target: ${targetName}`,
      {
        code: "IOS_BUILD_TARGET_UNKNOWN",
        context: { subsystem: "mobile-build", targetName },
        severity: "fatal",
      },
    );
  }
  return IOS_BUILD_TARGETS[targetName];
}

/** @param {string|undefined} value */
function normalizedEnvValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} key
 * @param {string} value
 */
function setDefaultEnv(env, key, value) {
  if (normalizedEnvValue(env[key]) == null) env[key] = value;
}

/**
 * Resolves the environment consumed by every phase of an iOS build. A named
 * pure-cloud target rejects a contradictory renderer mode, owns the release
 * classification, then erases inherited local-engine capability signals
 * before payload decisions run.
 *
 * @param {string} targetName
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string|undefined>}
 */
export function resolveIosBuildEnvironment(targetName, env = {}) {
  const target = resolveIosBuildTargetPolicy(targetName);
  const targetOwnsEnvironment = target.environmentAuthority === "target";
  const requestedRuntimeMode = normalizedEnvValue(
    env.VITE_ELIZA_IOS_RUNTIME_MODE,
  );
  if (
    targetOwnsEnvironment &&
    requestedRuntimeMode != null &&
    requestedRuntimeMode !== target.iosRuntimeMode
  ) {
    throw new ElizaError(
      `[mobile-build] ${targetName} requires VITE_ELIZA_IOS_RUNTIME_MODE=${target.iosRuntimeMode}; ` +
        `received ${requestedRuntimeMode}. Use build:ios for cloud-hybrid or build:ios:local for local runtime.`,
      {
        code: "IOS_BUILD_RUNTIME_MODE_CONFLICT",
        context: {
          subsystem: "mobile-build",
          targetName,
          requestedRuntimeMode,
          requiredRuntimeMode: target.iosRuntimeMode,
        },
        severity: "fatal",
      },
    );
  }

  const resolved = { ...env };
  if (targetOwnsEnvironment) {
    resolved.ELIZA_BUILD_VARIANT = target.buildVariant;
    resolved.ELIZA_RELEASE_AUTHORITY = target.releaseAuthority;
  } else {
    setDefaultEnv(resolved, "ELIZA_BUILD_VARIANT", target.buildVariant);
    setDefaultEnv(resolved, "ELIZA_RELEASE_AUTHORITY", target.releaseAuthority);
  }

  const runtimeKeys = ["ELIZA_IOS_RUNTIME_MODE", "VITE_ELIZA_IOS_RUNTIME_MODE"];
  const executionKeys = [
    "ELIZA_RUNTIME_MODE",
    "RUNTIME_MODE",
    "LOCAL_RUNTIME_MODE",
    "VITE_ELIZA_RUNTIME_MODE",
  ];
  if (targetOwnsEnvironment) {
    for (const key of runtimeKeys) resolved[key] = target.iosRuntimeMode;
    for (const key of executionKeys) {
      resolved[key] = target.runtimeExecutionMode;
    }
  } else {
    for (const key of runtimeKeys) {
      setDefaultEnv(resolved, key, target.iosRuntimeMode);
    }
    for (const key of executionKeys) {
      setDefaultEnv(resolved, key, target.runtimeExecutionMode);
    }
  }

  if (target.localEngine === "forbidden") {
    resolved.ELIZA_IOS_APP_STORE_LOCAL_RUNTIME = "0";
    resolved.ELIZA_IOS_FULL_BUN_ENGINE = "0";
    resolved.ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE = "0";
    resolved.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE = "0";
    resolved.VITE_ELIZA_IOS_FULL_BUN_STRICT = "0";
    resolved.VITE_ELIZA_IOS_FULL_BUN_SMOKE = "0";
  }

  if (
    target.includeLlama === "disabled" ||
    resolved.ELIZA_BUILD_VARIANT?.toLowerCase() === "store" ||
    resolved.ELIZA_RELEASE_AUTHORITY === "apple-app-store"
  ) {
    resolved.ELIZA_IOS_INCLUDE_LLAMA = "0";
  } else {
    setDefaultEnv(resolved, "ELIZA_IOS_INCLUDE_LLAMA", "1");
  }

  if (targetName === "ios-local") {
    setDefaultEnv(
      resolved,
      "ELIZA_IOS_BUILD_DESTINATION",
      "generic/platform=iOS Simulator",
    );
    setDefaultEnv(resolved, "ELIZA_IOS_BUILD_SDK", "iphonesimulator");
  }
  return resolved;
}
