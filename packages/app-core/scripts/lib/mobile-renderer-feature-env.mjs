/**
 * Resolves renderer feature flags and cache policy for mobile build lanes.
 * Local iOS artifacts expose the existing runtime chooser so a sideload can
 * select its bundled agent without Cloud authentication. Every iOS renderer
 * also compiles the optional APNs transport gate, which is recorded in the
 * renderer manifest. Cloud-only Android artifacts enable the realtime voice
 * client without forcing eligibility; the server and normal client gates stay
 * authoritative.
 * Lanes with feature values that remain unstamped start from a fresh renderer,
 * and explicit reuse requires a stale-risk acknowledgement.
 */

const ANDROID_CLOUD_DEBUG = "android-cloud-debug";
const ANDROID_CLOUD = "android-cloud";

export function resolveMobileRendererFeatureEnv({ platform, env = {} } = {}) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error("resolveMobileRendererFeatureEnv: platform is required");
  }
  if (platform === "ios-local") {
    return { VITE_ELIZA_ENABLE_RUNTIME_CHOOSER: "1" };
  }
  if (platform === "android-launcher") {
    return { VITE_ELIZA_ANDROID_LAUNCHER_BUILD: "1" };
  }
  const cloudAndroid =
    platform === ANDROID_CLOUD || platform === ANDROID_CLOUD_DEBUG;
  const isLp3Debug =
    platform === ANDROID_CLOUD_DEBUG &&
    env.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED === "1";
  if (!cloudAndroid) return {};
  const isLp3RemoteFallback = ["1", "true", "yes"].includes(
    String(env.ELIZA_ANDROID_LP3_REMOTE_FALLBACK_REQUIRED ?? "")
      .trim()
      .toLowerCase(),
  );
  const isVpsSidecar = ["1", "true", "yes"].includes(
    String(env.ELIZA_ANDROID_VPS_SIDECAR ?? "")
      .trim()
      .toLowerCase(),
  );
  return {
    VITE_VOICE_REALTIME_WS: "1",
    // A production self-hosted artifact may arm realtime only after its paired
    // same-origin runtime proves the authenticated voice-session contract is
    // available. This is distinct from the developer force override: the
    // runtime remains authoritative and provider credentials stay server-side.
    VITE_VOICE_REALTIME_SELF_HOSTED:
      isVpsSidecar || (isLp3Debug && isLp3RemoteFallback) ? "1" : "0",
    // Never inherit an ambient debug-force flag into a device artifact. A
    // Cloud mobile build may use realtime only when the normal eligibility
    // contract and server gate both pass.
    VITE_VOICE_REALTIME_FORCE: "0",
    ...(isLp3Debug && isLp3RemoteFallback
      ? {
          VITE_ENABLE_STREAM: "false",
          VITE_ELIZA_ANDROID_LP3_SHARED_BROWSER_STORAGE: "1",
        }
      : {}),
  };
}

export function mobileRendererRequiresFreshBuild({ platform } = {}) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error("mobileRendererRequiresFreshBuild: platform is required");
  }
  return (
    platform === ANDROID_CLOUD ||
    platform === ANDROID_CLOUD_DEBUG ||
    platform === "android-launcher" ||
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
  if (platform === ANDROID_CLOUD) {
    return "dist cannot prove the Android cloud realtime voice flags because they are not stamped";
  }
  if (platform === "android-launcher") {
    return "dist cannot prove the Android launcher in-app auth contract because it is not stamped";
  }
  return null;
}
