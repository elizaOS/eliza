/**
 * Persists a newly issued bearer credential across the active server and its
 * matching profile so every reconnect path observes the same authenticated
 * target. Pairing and bootstrap exchange both route through this boundary.
 */

import { getActiveProfile, updateAgentProfile } from "./agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

export function persistActiveServerCredential(token: string): void {
  const activeServer = loadPersistedActiveServer();
  if (activeServer && activeServer.kind !== "local") {
    savePersistedActiveServer({ ...activeServer, accessToken: token });
  }

  const activeProfile = getActiveProfile();
  if (activeProfile && activeProfile.kind !== "local") {
    updateAgentProfile(activeProfile.id, { accessToken: token });
  }
}
