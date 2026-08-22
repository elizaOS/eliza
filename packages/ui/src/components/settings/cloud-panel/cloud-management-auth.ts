/** Resolves the credential forms accepted by native Cloud management routes. */
import { getElizaApiToken } from "@elizaos/shared";
import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { normalizeCloudApiKeyToken } from "../../../cloud/lib/cloud-api-key-token";
import { getBootConfig } from "../../../config/boot-config";

interface CloudManagementCredentialSources {
  stewardToken: string | null | undefined;
  bootApiToken: string | null | undefined;
  runtimeApiToken: string | null | undefined;
}

/** Apply the same Steward-first, owner-key-fallback contract as the Cloud API transport. */
export function resolveCloudManagementToken({
  stewardToken,
  bootApiToken,
  runtimeApiToken,
}: CloudManagementCredentialSources): string {
  const steward = stewardToken?.trim();
  if (steward) return steward;
  return (
    normalizeCloudApiKeyToken(bootApiToken) ??
    normalizeCloudApiKeyToken(runtimeApiToken) ??
    ""
  );
}

/** Read the live credential chain available to this renderer window. */
export function currentCloudManagementToken(): string {
  return resolveCloudManagementToken({
    stewardToken: readStoredStewardToken(),
    bootApiToken: getBootConfig().apiToken,
    runtimeApiToken: getElizaApiToken(),
  });
}

export function hasCloudManagementCredential(): boolean {
  return currentCloudManagementToken().length > 0;
}
