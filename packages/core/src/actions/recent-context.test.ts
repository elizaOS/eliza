import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { State } from "../types/state";
import {
	recentConversationTexts,
	recentConversationTextsFromState,
} from "./recent-context";

it("includes a rendered history projection only once when composed state already embeds it", () => {
	const history =
		"# Conversation Messages (2 retained)\nuser: again\nuser: again";
	const text = `# UI Context\nview: chat\n# People\nowner\n${history}\n# Received Message\nremind me`;
	const state = {
		values: { recentMessages: history },
		text,
		data: {
			providers: {
				RECENT_MESSAGES: {
					data: {
						recentMessages: [
							{ content: { text: "again" } },
							{ content: { text: "again" } },
						],
					},
				},
			},
		},
	} as unknown as State;
	expect(recentConversationTextsFromState(state)).toEqual([
		text,
		"again",
		"again",
	]);
});
it("retains differently rendered or unavailable composed history without normalizing whitespace", () => {
	const state = {
		values: { recentMessages: "user: two  spaces\n" },
		text: "# UI\nuser: two spaces\n",
	} as unknown as State;
	expect(recentConversationTextsFromState(state)).toEqual([
		"user: two  spaces\n",
		"# UI\nuser: two spaces\n",
	]);
	expect(
		recentConversationTextsFromState({
			values: { recentMessages: "history" },
		} as unknown as State),
	).toEqual(["history"]);
});
it("does not collapse a partial overlap", () => {
	const state = {
		values: { recentMessages: "user: one\nuser: two" },
		text: "user: two\nuser: three",
	} as unknown as State;
	expect(recentConversationTextsFromState(state)).toEqual([
		"user: one\nuser: two",
		"user: two\nuser: three",
	]);
});

it("preserves short plain state text even if it appears in unrelated composed prose", () => {
	expect(
		recentConversationTextsFromState({
			values: { recentMessages: "yes" },
			text: "The owner said yes.",
		} as unknown as State),
	).toEqual(["yes", "The owner said yes."]);
});
it("keeps DB and provider occurrences unchanged alongside the single rendered block", async () => {
	const history = "# Conversation Messages (1 retained)\nuser: repeat";
	const text = `# UI Context\nchat\n${history}\n# Received Message\nrepeat`;
	const result = await recentConversationTexts({
		runtime: {
			getMemories: async () => [
				{ content: { text: "repeat" } },
				{ content: { text: "repeat" } },
			],
		} as never,
		message: { roomId: "room" } as never,
		state: {
			values: { recentMessages: history },
			text,
			data: {
				providers: {
					RECENT_MESSAGES: {
						data: { recentMessages: [{ content: { text: "repeat" } }] },
					},
				},
			},
		} as unknown as State,
	});
	expect(result).toEqual(["repeat", "repeat", text, "repeat"]);
});

function memory(id: string | undefined, text: string, roomId = "room") {
	return {
		...(id ? { id } : {}),
		roomId,
		entityId: "speaker",
		createdAt: 42,
		content: { text },
	};
}
function stateWithMessages(
	messages: unknown[],
	text = "# UI\nKeep current view and owner constraints.",
) {
	return {
		text,
		data: {
			providers: { RECENT_MESSAGES: { data: { recentMessages: messages } } },
		},
	} as unknown as State;
}
it("removes only an exact record's second raw representation and leaves composed context intact", async () => {
	const stored = memory(randomUUID(), "Line one\nKeep two  spaces.\n");
	const composed =
		"# Conversation Messages (1 retained)\n42 [speaker] owner: Line one\nKeep two  spaces.\n# Received Message\nDo not change views.";
	const state = stateWithMessages([structuredClone(stored)], composed);
	const before = structuredClone(state);
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state,
		}),
	).toEqual([stored.content.text, composed]);
	expect(state).toEqual(before);
});
it("preserves different IDs, missing IDs, foreign rooms and fresh state-only messages", async () => {
	const state = stateWithMessages([
		memory("b", "repeat"),
		memory(undefined, "repeat"),
		memory("a", "repeat", "other-room"),
		memory("fresh", "current correction"),
	]);
	expect(
		await recentConversationTexts({
			runtime: {
				getMemories: async () => [
					memory("a", "repeat"),
					memory(undefined, "repeat"),
				],
			} as never,
			message: { roomId: "room" } as never,
			state,
		}),
	).toEqual([
		"repeat",
		"repeat",
		state.text,
		"repeat",
		"repeat",
		"repeat",
		"current correction",
	]);
});
it("keeps same-ID conflicting content, temporal, metadata and privacy versions", async () => {
	const stored = {
		...memory("a", "same text"),
		metadata: { privacy: "owner", toolReceiptId: "receipt-a" },
	};
	const versions = [
		{ ...stored, createdAt: 43 },
		{ ...stored, entityId: "other-speaker" },
		{ ...stored, metadata: { privacy: "owner", toolReceiptId: "receipt-b" } },
		{
			...stored,
			content: { text: "same text", attachments: [{ id: "attachment" }] },
		},
		{ ...stored, unknownField: undefined },
	];
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state: stateWithMessages(versions),
		}),
	).toHaveLength(7);
	expect(
		await recentConversationTexts({
			runtime: {
				getMemories: async () => [
					stored,
					{ ...stored, content: { text: "conflicting DB version" } },
				],
			} as never,
			message: { roomId: "room" } as never,
			state: stateWithMessages([structuredClone(stored)]),
		}),
	).toEqual([
		"same text",
		"conflicting DB version",
		"# UI\nKeep current view and owner constraints.",
		"same text",
	]);
});
it("retains DB-only tool receipts, source order and the once-rendered history", async () => {
	const current = memory("current", "in-app only; no native app");
	const receipt = {
		...memory("receipt", "Complete receipt at 2026-09-29T07:00:00Z"),
		content: {
			type: "action_result",
			text: "Complete receipt at 2026-09-29T07:00:00Z",
		},
	};
	const earlier = memory("earlier", "use tomorrow instead");
	const history =
		"# Conversation Messages (2 retained)\nowner: in-app only; no native app\nowner: use tomorrow instead";
	const state = stateWithMessages(
		[earlier, current],
		`# Facts\nLocal timezone\n${history}`,
	);
	state.values = { recentMessages: history };
	expect(
		await recentConversationTexts({
			runtime: {
				getMemories: async () => [current, receipt, earlier],
			} as never,
			message: { roomId: "room" } as never,
			state,
		}),
	).toEqual([
		current.content.text,
		receipt.content.text,
		earlier.content.text,
		state.text,
	]);
});
it("propagates history storage errors instead of substituting state-only context", async () => {
	const error = new Error("history store unavailable");
	const reports: unknown[][] = [];
	await expect(
		recentConversationTexts({
			runtime: {
				getMemories: async () => {
					throw error;
				},
				reportError: (...args: unknown[]) => {
					reports.push(args);
				},
			} as never,
			message: { roomId: "room" } as never,
			state: stateWithMessages([memory("a", "retained")]),
		}),
	).rejects.toBe(error);
	expect(reports).toEqual([
		["RecentContext.getMemories", error, { roomId: "room" }],
	]);
});

it("retains an empty state projection when the matching DB row emitted no text", async () => {
	const empty = memory(randomUUID(), "");
	const state = stateWithMessages([structuredClone(empty)]);
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [empty] } as never,
			message: { roomId: "room" } as never,
			state,
		}),
	).toEqual([state.text, ""]);
});

it("matches complete plain records independent of property order without coercing undefined", async () => {
	const stored = {
		...memory("a", "exact"),
		metadata: { left: 1, right: [true, null, "x"] },
	};
	const reordered = {
		metadata: { right: [true, null, "x"], left: 1 },
		content: { text: "exact" },
		createdAt: 42,
		entityId: "speaker",
		roomId: "room",
		id: "a",
	};
	const state = stateWithMessages([reordered]);
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state,
		}),
	).toEqual(["exact", state.text]);
	const withUndefined = {
		...reordered,
		metadata: { ...reordered.metadata, explicitUndefined: undefined },
	};
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state: stateWithMessages([withUndefined]),
		}),
	).toHaveLength(3);
});

it("preserves accessor and unsupported record shapes without invoking metadata getters", async () => {
	let reads = 0;
	const meta = () =>
		Object.defineProperty({}, "private", {
			enumerable: true,
			get() {
				reads++;
				throw Error("must not invoke");
			},
		});
	const stored = { ...memory("a", "exact"), metadata: meta() };
	const projected = { ...memory("a", "exact"), metadata: meta() };
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state: stateWithMessages([projected]),
		}),
	).toHaveLength(3);
	expect(reads).toBe(0);
	class CustomMetadata {
		value = 1;
	}
	for (const pair of [
		[new Uint8Array([1]), new Uint8Array([1])],
		[new CustomMetadata(), new CustomMetadata()],
	]) {
		expect(
			await recentConversationTexts({
				runtime: {
					getMemories: async () => [
						{ ...memory("a", "exact"), metadata: pair[0] },
					],
				} as never,
				message: { roomId: "room" } as never,
				state: stateWithMessages([
					{ ...memory("a", "exact"), metadata: pair[1] },
				]),
			}),
		).toHaveLength(3);
	}
});

it("preserves cyclic copies but can identify the exact same memory object", async () => {
	const first: Record<string, unknown> = {};
	first.self = first;
	const second: Record<string, unknown> = {};
	second.self = second;
	const stored = { ...memory("a", "exact"), metadata: first };
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state: stateWithMessages([{ ...memory("a", "exact"), metadata: second }]),
		}),
	).toHaveLength(3);
	const state = stateWithMessages([stored]);
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state,
		}),
	).toEqual(["exact", state.text]);
});

it("matches frozen and unfrozen data for the same ID but preserves a distinct frozen occurrence", async () => {
	const stored = memory(randomUUID(), "same repeated text");
	const same = structuredClone(stored);
	Object.freeze(same.content);
	Object.freeze(same);
	const distinct = { ...structuredClone(stored), id: randomUUID() };
	Object.freeze(distinct.content);
	Object.freeze(distinct);
	const state = stateWithMessages([same, distinct]);
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [stored] } as never,
			message: { roomId: "room" } as never,
			state,
		}),
	).toEqual(["same repeated text", state.text, "same repeated text"]);
	const unfrozenState = stateWithMessages([structuredClone(stored)]);
	expect(
		await recentConversationTexts({
			runtime: { getMemories: async () => [same] } as never,
			message: { roomId: "room" } as never,
			state: unfrozenState,
		}),
	).toEqual(["same repeated text", unfrozenState.text]);
});
