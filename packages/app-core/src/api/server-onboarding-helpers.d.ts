/**
 * Onboarding compat helpers — API key persistence, onboarding defaults,
 * cloud-mode detection, and cloud-provisioned container detection.
 */
export declare function hasLegacyOnboardingRequestFields(
  body: Record<string, unknown>,
): boolean;
/**
 * Extract canonical onboarding credential inputs from an onboarding request body
 * and persist them to config + process.env. Returns the env key name if a local
 * provider API key was persisted, or null.
 */
export declare function extractAndPersistOnboardingApiKey(
  body: Record<string, unknown>,
): Promise<string | null>;
export declare function persistCompatOnboardingDefaults(
  body: Record<string, unknown>,
): string | null;
export declare function deriveCompatOnboardingReplayBody(
  body: Record<string, unknown>,
): {
  isCloudMode: boolean;
  replayBody: Record<string, unknown>;
};
/**
 * Check if this is a cloud-provisioned container.
 *
 * METADATA-ONLY. This function exists so routes like `/api/cloud/status` can
 * branch on cloud-provisioned shape. It does NOT authorise anything: callers
 * must still pass through `ensureCompatApiAuthorized` (bearer token) or
 * `ensureAuthSessionOrBootstrap`.
 */
export declare function isCloudProvisioned(): boolean;
//# sourceMappingURL=server-onboarding-helpers.d.ts.map
