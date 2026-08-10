/**
 * Resolves the TUI sender identity from the same persisted store that sends
 * runtime messages, so role grants cannot target a throwaway fallback user.
 */
import type { UUID } from "@elizaos/core";
import { useStore } from "./store.js";

export async function resolveTuiOwnerUserId(): Promise<UUID> {
  if (!useStore.getState().sessionLoaded) {
    await useStore.getState().loadSessionState();
  }
  return useStore.getState().identity.userId;
}
