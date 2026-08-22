/**
 * Conversation text extraction. Pulls every available conversation line from
 * `State` (the `recentMessages` / `text` values plus the recent-messages memory
 * array), strips language-agnostic speaker-prefix labels ("Name: …"), and dedupes
 * while preserving order. `recentConversationTexts` additionally falls back to
 * `runtime.getMemories` on the room's `messages` table when state alone is too
 * thin. Storage failures propagate so missing history is not mistaken for a
 * legitimately short conversation.
 */
import { getRecentMessagesData } from "../recent-messages-state";
import type { IAgentRuntime, Memory, State } from "../types";

// Match any speaker prefix pattern: "word:" or "word word:" at the start of a line.
// This is language-agnostic — strips any short prefix label followed by a colon,
// rather than hardcoding specific English role names.
const STATE_SPEAKER_PREFIX_RE =
	/^[a-zA-Z\u00C0-\u024F\u0400-\u04FF\u3000-\u9FFF]{1,20}\s*:\s*/;

function normalizeConversationLine(value: string): string {
	return value.replace(STATE_SPEAKER_PREFIX_RE, "").trim();
}

function splitConversationText(value: string): string[] {
	return value
		.split(/\n+/)
		.map((line) => normalizeConversationLine(line))
		.filter((line) => line.length > 0);
}

function dedupePreservingOrder(values: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const value of values) {
		if (seen.has(value)) {
			continue;
		}
		seen.add(value);
		deduped.push(value);
	}
	return deduped;
}

export function recentConversationTextsFromState(
	state: State | undefined,
	_limit?: number,
): string[] {
	const collected: string[] = [];
	const pushText = (value: unknown) => {
		if (typeof value === "string" && value.trim().length > 0) {
			collected.push(...splitConversationText(value));
		}
	};

	pushText(state?.values?.recentMessages);
	pushText((state as { text?: unknown })?.text);

	for (const item of getRecentMessagesData(state)) {
		const content = item.content;
		if (content && typeof content === "object") {
			pushText((content as Record<string, unknown>).text);
		}
	}

	return dedupePreservingOrder(collected);
}

export async function recentConversationTexts(args: {
	runtime: IAgentRuntime;
	message?: Memory;
	state: State | undefined;
	limit: number;
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
						typeof memory.content.text === "string"
							? normalizeConversationLine(memory.content.text)
							: "",
					)
					.filter((text) => text.length > 0)
			: [];
		return dedupePreservingOrder([...memoryTexts, ...stateTexts]);
	} catch (error) {
		// error-policy:J2 A failed history read is not equivalent to an empty room;
		// report the room context and preserve the storage error.
		args.runtime.reportError("RecentContext.getMemories", error, { roomId });
		throw error;
	}
}
