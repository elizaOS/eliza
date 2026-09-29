/**
 * Conversation text extraction. Pulls every available conversation line from
 * `State` (the `recentMessages` / `text` values plus the recent-messages memory
 * array) without splitting, trimming, or rewriting it. A complete rendered
 * history projection already embedded in composed text is included once;
 * distinct memory occurrences remain in source order. `recentConversationTexts`
 * additionally reads the room's `messages` table and appends complete state
 * context. Storage failures propagate so missing history is not mistaken for a
 * legitimately short conversation.
 */

import { getRecentMessagesData } from "../recent-messages-state";
import type { Memory } from "../types/memory.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { CONVERSATION_MESSAGES_HEADER_PREFIX } from "../utils";

export function recentConversationTextsFromState(
	state: State | undefined,
	_limit?: number,
): string[] {
	const collected: string[] = [];
	const pushText = (value: unknown) => {
		if (typeof value === "string") {
			collected.push(value);
		}
	};

	const renderedHistory = state?.values?.recentMessages;
	const composedText = (state as { text?: unknown })?.text;
	// The composed state already carries this exact rendered history block.
	// Keep distinct memory occurrences below; only omit its redundant projection.
	if (
		typeof renderedHistory !== "string" ||
		!renderedHistory.startsWith(CONVERSATION_MESSAGES_HEADER_PREFIX) ||
		typeof composedText !== "string" ||
		!composedText.includes(renderedHistory)
	) {
		pushText(renderedHistory);
	}
	pushText(composedText);

	for (const item of getRecentMessagesData(state)) {
		const content = item.content;
		if (content && typeof content === "object") {
			pushText((content as Record<string, unknown>).text);
		}
	}

	// Do NOT dedupe. Two distinct conversation turns with identical wording are
	// still two turns — collapsing them drops an occurrence before model
	// extractors build prompt context (#24858).
	return collected;
}

export async function recentConversationTexts(args: {
	runtime: IAgentRuntime;
	message?: Memory;
	state: State | undefined;
	/** @deprecated Complete conversation context is always returned. */
	limit?: number;
}): Promise<string[]> {
	const stateTexts = recentConversationTextsFromState(args.state);
	const roomId =
		typeof args.message?.roomId === "string" ? args.message.roomId : "";

	if (!roomId || typeof args.runtime.getMemories !== "function") {
		return stateTexts;
	}

	try {
		const memories = await args.runtime.getMemories({
			roomId,
			tableName: "messages",
		});
		const memoryTexts = Array.isArray(memories)
			? memories
					.map((memory) =>
						memory.content && typeof memory.content.text === "string"
							? memory.content.text
							: "",
					)
					.filter((text) => text.length > 0)
			: [];
		// Preserve every occurrence, including identical wording from distinct
		// turns — deduping drops occurrences before prompt assembly (#24858).
		return [...memoryTexts, ...stateTexts];
	} catch (error) {
		// error-policy:J2 A failed history read is not equivalent to an empty room;
		// report the room context and preserve the storage error.
		args.runtime.reportError("RecentContext.getMemories", error, { roomId });
		throw error;
	}
}
