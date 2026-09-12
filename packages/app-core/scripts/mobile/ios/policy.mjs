/** Resolves iOS runtime inclusion, deployment targets, and build policy from explicit environment inputs. */
import process from "node:process";
import { isTruthyEnv } from "../environment.mjs";

export const IOS_DEFAULT_DEPLOYMENT_TARGET = "16.0";

export const IOS_FULL_BUN_DEPLOYMENT_TARGET = "16.0";

export function shouldDisableIosPrivilegedCapabilities(env = process.env) {
  return (
    isTruthyEnv(env.ELIZA_IOS_DISABLE_PRIVILEGED_CAPABILITIES) ||
    isTruthyEnv(env.ELIZA_IOS_PERSONAL_TEAM_PROFILE)
  );
}

export function resolveIosBuildConfiguration(env = process.env) {
  const value = String(env.ELIZA_IOS_BUILD_CONFIGURATION ?? "Debug").trim();
  if (value === "Debug" || value === "Release") return value;
  throw new Error(
    `ELIZA_IOS_BUILD_CONFIGURATION must be Debug or Release, got ${value}`,
  );
}

export function isFullIosBunEngineRequested(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_FULL_BUN_ENGINE);
}

export function isIosAppStoreLocalRuntimeEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(
    String(env.ELIZA_IOS_APP_STORE_LOCAL_RUNTIME ?? "1").trim(),
  );
}

export function isIosLlamaRequested(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_INCLUDE_LLAMA);
}

export function shouldIncludeIosLlama(env = process.env) {
  return !isIosAppStoreBuild(env) && isIosLlamaRequested(env);
}

export function shouldUseIosFusedLocalInference(env = process.env) {
  return (
    shouldIncludeIosLlama(env) &&
    (isTruthyEnv(env.ELIZA_IOS_FUSED_LOCAL_INFERENCE) ||
      isTruthyEnv(env.ELIZA_IOS_REQUIRE_LOCAL_MODELS))
  );
}

export function shouldCleanIosBuildProducts(env = process.env) {
  return (
    isTruthyEnv(env.ELIZA_IOS_CLEAN_BUILD_PRODUCTS) ||
    shouldDisableIosPrivilegedCapabilities(env)
  );
}

export function shouldSkipIosCapacitorSync(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_SKIP_CAPACITOR_SYNC);
}

export function shouldSkipIosPodInstall(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_SKIP_POD_INSTALL);
}

// An iOS build ships the on-device no-JIT Bun engine (and thus a real local
// agent) when it is explicitly requested, OR when it is a store/App Store build
// with the local runtime left enabled (the default). App Store builds are
// cloud-hybrid: they keep the App Store-safe local runtime unless an operator
// opts into a cloud-only thin client via ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0.
// Exported so the release preflight + tests share one definition of "will the
// shipped IPA actually contain a local agent runtime".
export function shouldIncludeIosFullBunEngine(env = process.env) {
  return (
    isFullIosBunEngineRequested(env) ||
    (isIosAppStoreBuild(env) && isIosAppStoreLocalRuntimeEnabled(env))
  );
}

export function resolveIosCapacitorSyncEnv(env = process.env) {
  if (!shouldIncludeIosFullBunEngine(env)) return { ...env };

  // Capacitor installs discovered plugin pods before the repository-owned
  // Podfile can add ElizaBunEngine. Keep that intermediate install on the
  // compatibility source set; prepareIosOverlay then writes both the engine
  // and its dependent runtime plugin into the final pod graph.
  return { ...env, ELIZA_IOS_FULL_BUN_ENGINE: "0" };
}

export function isIosAppStoreBuild(env = process.env) {
  return (
    env.ELIZA_RELEASE_AUTHORITY === "apple-app-store" ||
    env.ELIZA_BUILD_VARIANT?.toLowerCase() === "store"
  );
}

export function resolveIosDeploymentTarget(env = process.env) {
  return shouldIncludeIosFullBunEngine(env)
    ? IOS_FULL_BUN_DEPLOYMENT_TARGET
    : IOS_DEFAULT_DEPLOYMENT_TARGET;
}

export function isIosSimulatorBuildTarget(buildTarget) {
  return (
    buildTarget?.sdk === "iphonesimulator" ||
    /\bSimulator\b/i.test(buildTarget?.destination ?? "")
  );
}

export function shouldEnforceIosBunEngineAppStoreRuntime(buildTarget) {
  return (
    !isIosSimulatorBuildTarget(buildTarget) ||
    isTruthyEnv(process.env.ELIZA_BUN_IOS_STRICT_APP_STORE_RUNTIME) ||
    isTruthyEnv(process.env.ELIZA_IOS_STRICT_APP_STORE_RUNTIME)
  );
}
