import type { Memory, State } from "./types";

/**
 * Read the recent-messages memory array that `recentMessagesProvider` writes
 * into `state.data.providers.RECENT_MESSAGES.data.recentMessages`.
 *
 * This is the canonical path — the provider system does not populate any other
 * location. Canonical owner lives here in `@elizaos/core`; `@elizaos/shared`
 * re-exports it so agent/plugin callers share one accessor. Don't reinvent this
 * access in each caller.
 */
export function getRecentMessagesData(state: State | undefined): Memory[] {
	const messages =
		state?.data?.providers?.RECENT_MESSAGES?.data?.recentMessages;
	return Array.isArray(messages) ? (messages as Memory[]) : [];
}
