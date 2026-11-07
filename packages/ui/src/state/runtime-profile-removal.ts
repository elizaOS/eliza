import { client } from "../api/client";
import type { AgentProfileRegistry } from "./agent-profile-types";
import { loadAgentProfileRegistry, removeAgentProfile } from "./agent-profiles";
import { clearPersistedActiveServer } from "./persistence";
import { switchRuntimeNonDestructive } from "./switch-runtime";
export function removeProfileWithoutStaleSelection(
  profileId: string,
  dependencies: {
    loadRegistry: () => AgentProfileRegistry;
    switchRuntime: (profileId: string) => {
      ok: boolean;
    };
    clearRuntimeSelection: () => void;
    removeProfile: (profileId: string) => void;
  } = {
    loadRegistry: loadAgentProfileRegistry,
    switchRuntime: switchRuntimeNonDestructive,
    clearRuntimeSelection: () => {
      clearPersistedActiveServer();
      client.setToken(null);
      client.setBaseUrl(null);
    },
    removeProfile: removeAgentProfile,
  },
): void {
  const registry = dependencies.loadRegistry();
  if (registry.activeProfileId === profileId) {
    const fallback =
      registry.profiles.find(
        (profile) => profile.id !== profileId && profile.kind === "local",
      ) ?? registry.profiles.find((profile) => profile.id !== profileId);
    if (!fallback) {
      dependencies.clearRuntimeSelection();
    } else if (!dependencies.switchRuntime(fallback.id).ok) {
      throw new Error(
        "The runtime could not be removed because the fallback runtime was not saved. Try again.",
      );
    }
  }
  dependencies.removeProfile(profileId);
}
