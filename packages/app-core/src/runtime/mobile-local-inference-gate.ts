/**
 * On a mobile platform (`ELIZA_PLATFORM=android` / `ios`) the runtime skips
 * nearly every boot helper because they shell out to subprocesses,
 * platform-specific binaries, or optional packages that aren't in the mobile
 * bundle. Two mobile-safe inference paths still need wiring:
 *
 *   - `ELIZA_DEVICE_BRIDGE_ENABLED=1`: the agent (this process) hosts the
 *     device-bridge WSS and dials whichever paired device connects. On the
 *     Capacitor APK the WebView's `@elizaos/capacitor-llama` is the intended
 *     dialer over loopback. The Capacitor build always exports this env so
 *     the bridge is ready as soon as onboarding picks the local mode.
 *
 *   - `ELIZA_LOCAL_LLAMA=1`: AOSP-only path that loads node-llama-cpp
 *     directly inside the Android process. Wired here so the gate is in
 *     place ahead of sub-task 2 — the AOSP build flag flips this on.
 *
 * Kept dependency-free so it can be unit-tested without instantiating the
 * full runtime.
 */
export function shouldEnableMobileLocalInference(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const deviceBridge = env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
  const localLlama = env.ELIZA_LOCAL_LLAMA?.trim() === "1";
  return deviceBridge || localLlama;
}
