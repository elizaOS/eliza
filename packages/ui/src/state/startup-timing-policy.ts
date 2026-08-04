/** Central timing policy for startup probes, retries, restore, and first paint. */

export const STARTUP_TIMING_POLICY = Object.freeze({
  splashDelayMs: 220,
  runtimePollIntervalMs: 500,
  recoveryBaseDelayMs: 2_500,
  recoveryMaxDelayMs: 30_000,
  recoveryMaxAttempts: 8,
  desktopRestoreRpcTimeoutMs: 5_000,
  stewardRestoreRefreshTimeoutMs: 4_000,
  cloudAgentTierProbeTimeoutMs: 12_000,
  nativeConsecutiveFailureBudgetMs: 90_000,
  probeRequestTimeoutMs: 12_000,
});
