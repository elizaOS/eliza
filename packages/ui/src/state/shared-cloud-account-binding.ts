/**
 * Atomically releases browser-persisted mirrors of an account-scoped shared
 * Cloud agent when its Steward account session ends.
 */

import { client } from "../api";
import { clearElizaApiBase } from "../utils/eliza-globals";
import { removeManagedSharedCloudAgentProfiles } from "./agent-profiles";
import {
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
