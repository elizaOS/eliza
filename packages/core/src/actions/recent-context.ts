/**
 * Conversation text extraction. Pulls every available conversation line from
 * `State` (the `recentMessages` / `text` values plus the recent-messages memory
 * array) without splitting, trimming, or rewriting it. A complete rendered
 * history projection already embedded in composed text is included once;
 * distinct memory occurrences remain in source order. `recentConversationTexts`
 * additionally reads the room's `messages` table and appends complete state
 * context, omitting only an identical identified memory's second raw projection. Storage failures propagate so missing history is not mistaken for a
 * legitimately short conversation.
 */

import { getRecentMessagesData } from "../recent-messages-state";
import type { Memory } from "../types/memory.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { CONVERSATION_MESSAGES_HEADER_PREFIX } from "../utils";

/** Compare complete plain data without invoking accessors or coercing values.
 * Unsupported shapes are uncertainty, so retain both representations. */
function sameMemoryData(left: unknown, right: unknown): boolean {
	const visiting = new Set<object>();
	const equal = (a: unknown, b: unknown): boolean => {
		if (Object.is(a, b)) return true;
		if (!a || !b || typeof a !== "object" || typeof b !== "object")
			return false;
		const prototype = Object.getPrototypeOf(a);
		if (
			prototype !== Object.getPrototypeOf(b) ||
			(prototype !== Object.prototype &&
				prototype !== null &&
				!(
					Array.isArray(a) &&
					Array.isArray(b) &&
					prototype === Array.prototype
				)) ||
			visiting.has(a) ||
			visiting.has(b)
		)
			return false;
		const aFields = Object.getOwnPropertyDescriptors(a);
		const bFields = Object.getOwnPropertyDescriptors(b);
		const keys = Reflect.ownKeys(aFields);
		if (keys.length !== Reflect.ownKeys(bFields).length) return false;
		visiting.add(a);
		visiting.add(b);
		try {
			return keys.every((key) => {
				if (!Object.hasOwn(bFields, key)) return false;
				const x = aFields[key as keyof typeof aFields];
				const y = bFields[key as keyof typeof bFields];
				return Boolean(
					x &&
						y &&
						"value" in x &&
						"value" in y &&
						x.enumerable === y.enumerable &&
						equal(x.value, y.value),
				);
			});
		} finally {
			visiting.delete(a);
			visiting.delete(b);
		}
	};
	try {
		return equal(left, right);
	} catch {
		// Reflection failure or excessive nesting is not proof of duplication.
		return false;
	}
}

function renderedConversationTextsFromState(
	state: State | undefined,
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
	return collected;
}

export function recentConversationTextsFromState(
	state: State | undefined,
	_limit?: number,
): string[] {
	const collected = renderedConversationTextsFromState(state);
	for (const item of getRecentMessagesData(state)) {
		const content = item.content;
		if (content && typeof content === "object") {
			const text = (content as Record<string, unknown>).text;
			if (typeof text === "string") collected.push(text);
		}
	}

	// Do NOT dedupe. Two distinct conversation turns with identical wording are
	// still two turns — collapsing them drops an occurrence before model
	// extractors build prompt context.
	return collected;
}

export async function recentConversationTexts(args: {
	runtime: IAgentRuntime;
	message?: Memory;
	state: State | undefined;
}): Promise<string[]> {
	const roomId =
		typeof args.message?.roomId === "string" ? args.message.roomId : "";

	if (!roomId || typeof args.runtime.getMemories !== "function") {
		return recentConversationTextsFromState(args.state);
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
		// Two projections of the same identified, structurally identical memory are
		// one occurrence. Never infer identity from text, speaker or timestamps:
		// different IDs, absent IDs, foreign rooms and conflicting versions stay.
		const byId = new Map<string, Memory[]>();
		for (const memory of Array.isArray(memories) ? memories : []) {
			if (
				!memory.id ||
				memory.roomId !== roomId ||
				typeof memory.content?.text !== "string" ||
				memory.content.text.length === 0
			)
				continue;
			const matches = byId.get(memory.id) ?? [];
			matches.push(memory);
			byId.set(memory.id, matches);
		}
		const stateTexts = renderedConversationTextsFromState(args.state);
		for (const memory of getRecentMessagesData(args.state)) {
			const matches =
				memory.id && memory.roomId === roomId ? byId.get(memory.id) : undefined;
			if (matches?.every((stored) => sameMemoryData(stored, memory))) continue;
			if (typeof memory.content?.text === "string")
				stateTexts.push(memory.content.text);
		}
		return [...memoryTexts, ...stateTexts];
	} catch (error) {
		// error-policy:J2 A failed history read is not equivalent to an empty room;
		// report the room context and preserve the storage error.
		args.runtime.reportError("RecentContext.getMemories", error, { roomId });
		throw error;
	}
}
