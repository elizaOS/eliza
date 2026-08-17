/**
 * Classifies native Browser-surface failures into permanent capability denials
 * versus transient transport faults, so the renderer can stop offering a Retry
 * that can never succeed (#15245 fail-closed posture, LP3 WebView 113).
 *
 * The Android plugin rejects `createSurface` when the system WebView cannot
 * honour the requested isolation: no androidx.webkit multi-profile support for
 * `storage: "isolated"`, or no out-of-app renderer for `process: "isolated"`.
 * Both are properties of the device's system WebView, not of the current
 * attempt; retrying reproduces the same rejection until the OS ships a newer
 * WebView. Security stays fail-closed — this module only changes what the user
 * is TOLD, never silently degrades to shared storage or an in-realm iframe.
 *
 * The patterns below are pinned against the exact Kotlin reject strings by
 * `native-surface-capability.test.ts`, which reads the plugin source from the
 * monorepo, so a message rewrite on the native side fails the test instead of
 * silently reclassifying a permanent denial as transient.
 */

/**
 * Permanent isolation-capability denials the native side can emit. Each entry
 * must keep matching the literal `call.reject(...)` string in
 * `plugins/plugin-native-browser-surface/android/.../BrowserSurfacePlugin.kt`.
 */
const CAPABILITY_DENIAL_PATTERNS: readonly RegExp[] = [
  /isolated storage requires WebView multi-profile support/i,
  /isolated process policy requires an out-of-app WebView renderer/i,
];

/**
 * True when the failure (or anything on its `cause` chain) is a permanent
 * device-capability denial rather than a transient transport fault. The shell
 * wraps native rejections in `NativeSurfaceUnavailableError` with the original
 * Capacitor rejection as `cause`, so the chain walk is what finds the native
 * message; a cycle guard keeps adversarial cause chains finite.
 */
export function isNativeSurfaceCapabilityDenial(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : null;
    if (
      message !== null &&
      CAPABILITY_DENIAL_PATTERNS.some((pattern) => pattern.test(message))
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}
