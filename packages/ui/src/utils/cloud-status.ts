/**
 * Classifies cloud-status reason codes — specifically whether a reason means "an
 * API key is present but the runtime isn't authenticated/started yet", so the UI
 * can distinguish key-present-but-not-live from fully-disconnected states.
 */
const CLOUD_STATUS_API_KEY_ONLY_REASONS: ReadonlySet<string> = new Set([
  "api_key_present_not_authenticated",
  "api_key_present_runtime_not_started",
]);

export function isCloudStatusReasonApiKeyOnly(
  reason: string | null | undefined,
): boolean {
  return (
    typeof reason === "string" && CLOUD_STATUS_API_KEY_ONLY_REASONS.has(reason)
  );
}

export function isCloudStatusAuthenticated(
  connected: boolean,
  reason: string | null | undefined,
): boolean {
  return connected && !isCloudStatusReasonApiKeyOnly(reason);
}
