import type { Memory } from "../types/memory";
import type { State } from "../types/state";

/**
 * Read the recent-messages memory array that `recentMessagesProvider` writes
 * into `state.data.providers.RECENT_MESSAGES.data.recentMessages`.
 *
 * This is the canonical path — the provider system does not populate any
 * other location. Don't reinvent this access in each caller. `@elizaos/shared`
 * re-exports this accessor so both runtime and non-runtime consumers share one
 * implementation.
 */
export function getRecentMessagesData(state: State | undefined): Memory[] {
	const messages =
		state?.data?.providers?.RECENT_MESSAGES?.data?.recentMessages;
	return Array.isArray(messages) ? (messages as Memory[]) : [];
}
