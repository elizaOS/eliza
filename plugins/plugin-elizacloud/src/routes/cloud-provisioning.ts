function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function hasCompatApiToken(): boolean {
  return hasValue(process.env.ELIZA_API_TOKEN);
}

function hasCloudApiKeyProvisioning(): boolean {
  return (
    process.env.ELIZAOS_CLOUD_ENABLED === "true" &&
    hasValue(process.env.ELIZAOS_CLOUD_API_KEY)
  );
}

/**
 * Platform-managed cloud containers should skip local pairing and onboarding UI.
 *
 * In production we may have either:
 * - a Steward sidecar token (older / sidecar-managed path),
 * - an inbound API token injected directly into the container, or
 * - cloud-managed API-key access injected into the runtime environment.
 *
 * Requiring the cloud flag plus one of those credentials keeps accidental local
 * env leakage from triggering cloud behavior, while still matching real deployed
 * cloud containers.
 */
export function isCloudProvisionedContainer(): boolean {
  const hasCloudFlag = process.env.ELIZA_CLOUD_PROVISIONED === "1";

  return (
    hasCloudFlag &&
    (hasValue(process.env.STEWARD_AGENT_TOKEN) ||
      hasCompatApiToken() ||
      hasCloudApiKeyProvisioning())
  );
}
