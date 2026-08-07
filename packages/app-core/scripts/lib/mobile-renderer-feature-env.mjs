/**
 * Resolves renderer feature flags and cache policy for mobile build lanes.
 * LP3 debug artifacts always enable the realtime voice client, while every
 * Android cloud-debug build starts from a fresh renderer because the current
 * lane stamp does not encode optional Vite feature flags.
 */

const ANDROID_CLOUD_DEBUG = "android-cloud-debug";

export function resolveMobileRendererFeatureEnv({ platform, env = {} } = {}) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error("resolveMobileRendererFeatureEnv: platform is required");
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
  return platform === ANDROID_CLOUD_DEBUG;
}
