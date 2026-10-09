/** Canonical reader for the memory array `recentMessagesProvider` publishes on runtime state; `@elizaos/core` re-exports it so every caller shares one accessor rather than re-deriving the provider path. */
import type { Memory } from "./types/memory.js";

interface RecentMessagesState {
	data?: {
		providers?: Record<
			string,
			{
				data?: Record<string, unknown>;
			}
		>;
	};
}
/**
 * Read the recent-messages memory array that `recentMessagesProvider` writes
 * into `state.data.providers.RECENT_MESSAGES.data.recentMessages`.
 *
 * This is the canonical path — the provider system does not populate any other
 * location. Agent and plugin callers use this accessor.
 */
export function getRecentMessagesData(
	state: RecentMessagesState | undefined,
): Memory[] {
	const messages =
		state?.data?.providers?.RECENT_MESSAGES?.data?.recentMessages;
	return Array.isArray(messages) ? (messages as Memory[]) : [];
}
