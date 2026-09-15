/** Exposes deterministic restore-race checkpoints for the real provisioning authority test harness. */

export interface ElizaSandboxServiceTestHooks {
  afterReviewedRestorePreflight?: () => Promise<void>;
  afterReviewedRestoreFence?: () => Promise<void>;
}
