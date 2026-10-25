/**
 * Canonical provenance strings for credentials minted by mobile App Auth.
 * Creation, reveal confirmation, cleanup, and lifecycle test fixtures share
 * these pure builders so an exact-ownership check cannot drift from issuance.
 */

export const MOBILE_APP_AUTH_CREDENTIAL_NAME_PREFIX = "Eliza mobile";
export const MOBILE_APP_AUTH_CREDENTIAL_DESCRIPTION_PREFIX = "First-party mobile credential";

export interface MobileAppAuthCredentialProvenanceInput {
  grantId: string;
  environment: string;
  deviceName?: string | null;
  clientId: string;
  scopes: readonly string[];
}

export function buildMobileAppAuthCredentialName(
  input: Pick<MobileAppAuthCredentialProvenanceInput, "deviceName" | "environment" | "grantId">,
): string {
  if (input.deviceName) {
    return `${MOBILE_APP_AUTH_CREDENTIAL_NAME_PREFIX} - ${input.deviceName} - ${input.environment} - ${input.grantId}`;
  }
  return `${MOBILE_APP_AUTH_CREDENTIAL_NAME_PREFIX} - ${input.environment} - ${input.grantId}`;
}

export function buildMobileAppAuthCredentialDescription(
  input: Pick<MobileAppAuthCredentialProvenanceInput, "clientId" | "scopes">,
): string {
  return `${MOBILE_APP_AUTH_CREDENTIAL_DESCRIPTION_PREFIX}; client=${input.clientId}; scope=${input.scopes.join(" ")}`;
}

export function buildMobileAppAuthCredentialProvenance(
  input: MobileAppAuthCredentialProvenanceInput,
): { description: string; name: string } {
  return {
    name: buildMobileAppAuthCredentialName(input),
    description: buildMobileAppAuthCredentialDescription(input),
  };
}
