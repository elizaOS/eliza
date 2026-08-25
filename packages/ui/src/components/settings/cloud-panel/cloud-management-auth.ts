/** Resolves the credential forms accepted by native Cloud management routes. */
import { getElizaApiToken } from "@elizaos/shared";
import {
  readStoredStewardToken,
  STEWARD_SESSION_CHANGE_EVENT,
} from "@elizaos/shared/steward-session-client";
import { useSyncExternalStore } from "react";
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

function subscribeToCloudManagementCredential(
  onStoreChange: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handleCredentialChange = () => onStoreChange();
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, handleCredentialChange);
  window.addEventListener("steward-token-sync", handleCredentialChange);
  // Cross-document storage events cover Steward removal and persisted runtime
  // token changes without coupling this boundary to every storage key name.
  window.addEventListener("storage", handleCredentialChange);
  return () => {
    window.removeEventListener(
      STEWARD_SESSION_CHANGE_EVENT,
      handleCredentialChange,
    );
    window.removeEventListener("steward-token-sync", handleCredentialChange);
    window.removeEventListener("storage", handleCredentialChange);
  };
}

function noCloudManagementCredential(): boolean {
  return false;
}

/** Reactively track every credential form accepted by Cloud management. */
export function useHasCloudManagementCredential(): boolean {
  return useSyncExternalStore(
    subscribeToCloudManagementCredential,
    hasCloudManagementCredential,
    noCloudManagementCredential,
  );
}
