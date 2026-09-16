/**
 * Atomically releases browser-persisted mirrors of an account-scoped shared
 * Cloud agent when its Steward account session ends.
 */

import { client } from "../api";
import { clearElizaApiBase } from "../utils/eliza-globals";
import {
  removeManagedCloudAgentProfilesDurably,
  removeManagedSharedCloudAgentProfiles,
} from "./agent-profiles";
import { isManagedCloudAgentServer } from "./agent-session-recovery";
import {
  clearPersistedActiveServerDurably,
  clearPersistedSharedCloudActiveServer,
  loadPersistedActiveServer,
} from "./persistence";

const STORED_API_BASE_KEY = "elizaos_api_base";

/**
 * Clear the active server, matching profile, boot/global base, and legacy
 * client-base storage mirror. Returns false for dedicated or self-hosted
 * selections, whose independent agent credentials remain recoverable.
 */
export function clearSharedCloudAccountBinding(): boolean {
  const activeServer = loadPersistedActiveServer();
  const apiBase = activeServer?.apiBase;
  if (!apiBase || !clearPersistedSharedCloudActiveServer()) return false;

  removeManagedSharedCloudAgentProfiles();
  client.setToken(null);
  client.setBaseUrl(null);
  clearElizaApiBase();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORED_API_BASE_KEY);
      window.sessionStorage.removeItem(STORED_API_BASE_KEY);
    } catch {
      // error-policy:J6 best-effort stale account-binding teardown; canonical
      // active-server and boot-config state has already been cleared.
    }
  }
  return true;
}

/**
 * Releases every browser mirror whose authority comes from the ending Eliza
 * Cloud account while preserving unrelated local and self-hosted profiles.
 */
export async function clearManagedCloudAccountBinding(): Promise<void> {
  const activeServer = loadPersistedActiveServer();
  if (isManagedCloudAgentServer(activeServer)) {
    await clearPersistedActiveServerDurably();
    client.setToken(null);
    client.setBaseUrl(null);
    clearElizaApiBase();
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORED_API_BASE_KEY);
        window.sessionStorage.removeItem(STORED_API_BASE_KEY);
      } catch {
        // error-policy:J6 account sign-out already cleared canonical managed
        // selection state; inaccessible compatibility mirrors cannot be reused.
      }
    }
  }
  await removeManagedCloudAgentProfilesDurably();
}
