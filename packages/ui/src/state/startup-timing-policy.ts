/** Central timing policy for startup probes, retries, restore, and first paint. */

export const STARTUP_TIMING_POLICY = Object.freeze({
  splashDelayMs: 220,
  runtimePollIntervalMs: 500,
  recoveryBaseDelayMs: 2_500,
  recoveryMaxDelayMs: 30_000,
  recoveryMaxAttempts: 8,
  stewardRestoreRefreshTimeoutMs: 4_000,
  nativeConsecutiveFailureBudgetMs: 90_000,
  remoteNativeConsecutiveFailureBudgetMs: 7_000,
  agentUnreachableFailureBudgetMs: 45_000,
  probeRequestTimeoutMs: 12_000,
});

function isCapacitorNativePlatform(): boolean {
  try {
    const cap = (
      globalThis as typeof globalThis & {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          getPlatform?: () => string;
        };
      }
    ).Capacitor;
    if (!cap) return false;
    if (typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) {
      return true;
    }
    if (typeof cap.getPlatform === "function") {
      const p = cap.getPlatform();
      return p === "ios" || p === "android";
    }
    return false;
  } catch {
    // error-policy:J4 capability probe — an unanswerable Capacitor check
    // means "not a native mobile shell".
    return false;
  }
}

/**
 * Builds that host the on-device agent get a 3-minute boot budget: AOSP /
 * branded ElizaOS Capacitor builds (UA carries `ElizaOS/<tag>`) and stock
 * Capacitor installs, which run the bundled local agent. Cold boot is ~30s
 * PGlite migration + ~30s agent registration before auth status responds.
 * Web / hosted-cloud builds keep the 30s budget so a real backend outage
 * surfaces fast.
 */
export function getBackendStartupTimeoutMs(): number {
  if (
    typeof navigator !== "undefined" &&
    /\bElizaOS\//.test(navigator.userAgent ?? "")
  ) {
    return 180_000;
  }
  if (isCapacitorNativePlatform()) {
    return 180_000;
  }
  return 30_000;
}
