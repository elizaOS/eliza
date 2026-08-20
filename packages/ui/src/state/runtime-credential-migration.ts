/** One-way migration from browser-persisted runtime bearers to secure refs. */
import { storeRuntimeCredential } from "../platform/runtime-credential-store";
import {
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
} from "./agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

export async function migrateLegacyRuntimeCredentials(): Promise<void> {
  const registry = loadAgentProfileRegistry();
  let profilesChanged = false;
  for (const profile of registry.profiles) {
    if (!profile.accessToken) continue;
    const credentialRef = profile.credentialRef ?? profile.id;
    await storeRuntimeCredential(credentialRef, profile.accessToken);
    profile.credentialRef = credentialRef;
    delete profile.accessToken;
    profilesChanged = true;
  }
  if (profilesChanged) saveAgentProfileRegistry(registry);

  const active = loadPersistedActiveServer();
  if (!active?.accessToken) return;
  const credentialRef = active.credentialRef ?? registry.activeProfileId;
  if (!credentialRef) return;
  await storeRuntimeCredential(credentialRef, active.accessToken);
  const scrubbed = { ...active, credentialRef };
  delete scrubbed.accessToken;
  savePersistedActiveServer(scrubbed);
}
