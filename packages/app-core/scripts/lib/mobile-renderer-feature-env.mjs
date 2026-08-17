/**
 * Resolves renderer feature flags and cache policy for mobile build lanes.
 * Local iOS artifacts expose the existing runtime chooser so a sideload can
 * select its bundled agent without Cloud authentication. Every iOS renderer
 * also compiles the optional APNs transport gate, which is recorded in the
 * renderer manifest. LP3 debug artifacts enable the realtime voice client.
 * Lanes with feature values that remain unstamped start from a fresh renderer,
 * and explicit reuse requires a stale-risk acknowledgement.
 */

const ANDROID_CLOUD_DEBUG = "android-cloud-debug";

export function resolveMobileRendererFeatureEnv({ platform, env = {} } = {}) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error("resolveMobileRendererFeatureEnv: platform is required");
  }
  if (platform === "ios-local") {
    return { VITE_ELIZA_ENABLE_RUNTIME_CHOOSER: "1" };
  }
  const isLp3Debug =
    platform === ANDROID_CLOUD_DEBUG &&
    env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED === "1";
  if (!isLp3Debug) return {};
  return {
    VITE_VOICE_REALTIME_WS: "1",
    VITE_VOICE_REALTIME_FORCE: "1",
  };
}

export function mobileRendererRequiresFreshBuild({ platform } = {}) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error("mobileRendererRequiresFreshBuild: platform is required");
  }
  return (
    platform === ANDROID_CLOUD_DEBUG ||
    platform === "ios" ||
    platform === "ios-local"
  );
}

/** Explain why a cached renderer cannot prove a still-unstamped feature. */
export function mobileRendererUnstampedFeatureProblem({ platform } = {}) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error(
      "mobileRendererUnstampedFeatureProblem: platform is required",
    );
  }
  if (platform === "ios-local") {
    return "dist cannot prove the iOS local runtime chooser because it is not stamped";
  }
  if (platform === ANDROID_CLOUD_DEBUG) {
    return "dist cannot prove the Android cloud-debug realtime voice flags because they are not stamped";
  }
  return null;
}
