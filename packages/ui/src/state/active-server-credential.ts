/**
 * Persists a newly issued bearer credential across the active server and its
 * matching profile so every reconnect path observes the same authenticated
 * target. Pairing and bootstrap exchange both route through this boundary.
 */

import { setStorageValue } from "../bridge/storage-bridge";
import { getActiveProfile, updateAgentProfile } from "./agent-profiles";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

export async function persistActiveServerCredential(
  token: string,
  pairedApiBase?: string,
): Promise<void> {
  const activeServer = loadPersistedActiveServer();
  const fallbackRemote = pairedApiBase?.trim()
    ? createPersistedActiveServer({
        kind: "remote",
        apiBase: pairedApiBase,
        accessToken: token,
      })
    : null;
  const credentialTarget =
    activeServer && activeServer.kind !== "local"
      ? { ...activeServer, accessToken: token }
      : fallbackRemote;
  if (credentialTarget) {
    const authenticatedServer = credentialTarget;
    savePersistedActiveServer(authenticatedServer);
    // Native storage mirroring is normally fire-and-forget, but pairing reloads
    // immediately after this boundary. Await the authoritative Preferences write
    // so hydration cannot restore the pre-pair, tokenless server on the next boot.
    await setStorageValue(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify(authenticatedServer),
    );
  }

  const activeProfile = getActiveProfile();
  if (activeProfile && activeProfile.kind !== "local") {
    updateAgentProfile(activeProfile.id, { accessToken: token });
  }
}

/**
 * Removes only the rejected bearer from the active target and profile. Other
 * saved targets keep their credentials so one expired agent cannot sign the
 * user out of every configured runtime.
 */
export function scrubRejectedActiveServerCredential(token: string): void {
  const rejected = token.trim();
  if (!rejected) return;

  const activeServer = loadPersistedActiveServer();
  if (activeServer?.accessToken === rejected) {
    const { accessToken: _rejected, ...serverWithoutToken } = activeServer;
    savePersistedActiveServer(serverWithoutToken);
  }

  const activeProfile = getActiveProfile();
  if (activeProfile?.accessToken === rejected) {
    updateAgentProfile(activeProfile.id, { accessToken: undefined });
  }
}
