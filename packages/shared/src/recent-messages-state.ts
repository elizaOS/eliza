import type { Memory, State } from "@elizaos/core";

/**
 * Read the recent-messages memory array that `recentMessagesProvider` writes
 * into `state.data.providers.RECENT_MESSAGES.data.recentMessages`.
 *
 * This is the canonical path — the provider system does not populate any
 * other location. Don't reinvent this access in each caller.
 */
export function getRecentMessagesData(state: State | undefined): Memory[] {
  const messages =
    state?.data?.providers?.RECENT_MESSAGES?.data?.recentMessages;
  return Array.isArray(messages) ? (messages as Memory[]) : [];
}
