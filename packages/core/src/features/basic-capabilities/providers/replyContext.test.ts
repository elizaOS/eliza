/**
 * Behavioral tests for the REPLY_CONTEXT provider: renders nothing on non-reply
 * turns, identifies the replied-to message, pulls the surrounding window, dedupes
 * that window against RECENT_MESSAGES, and refuses a cross-room / missing target.
 * Deterministic — drives `replyContextProvider.get` against a hand-built
 * in-memory runtime of `vi.fn` stubs that answers the two half-window
 * `getMemories` queries from a single sorted message list; no live model or DB.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import {
	MAX_REPLY_TARGET_SNIPPET_CHARS,
	MAX_REPLY_WINDOW_MESSAGE_CHARS,
	REPLY_CONTEXT_WINDOW_RADIUS,
	replyContextProvider,
	truncateSingleLine,
	withBoundedText,
} from "./replyContext.ts";

function isWellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const OTHER_ROOM_ID = "00000000-0000-0000-0000-000000000009" as UUID;

// The provider guards `content.inReplyTo` through validateUuid, so message ids
// must be real UUIDs — a plain label like "m4" is rejected as a forged value.
function idFor(label: string): UUID {
	let hash = 0;
	for (let i = 0; i < label.length; i += 1) {
		hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
	}
	const hex = hash.toString(16).padStart(12, "0").slice(0, 12);
	return `00000000-0000-4000-8000-${hex}` as UUID;
}

function mem(
	label: string,
	entityId: UUID,
	text: string,
	createdAt: number,
	roomId: UUID = ROOM_ID,
): Memory {
	return {
		id: idFor(label),
		agentId: AGENT_ID,
		roomId,
		entityId,
		createdAt,
		content: { text, source: "discord" },
	} as Memory;
}

/**
 * Runtime whose `getMemories` answers the provider's three queries off ONE
 * sorted list: the recent-window (no start/end), the older half (`end` +
 * desc), and the newer half (`start` + asc). Real filtering (bounds, order,
 * limit) is applied so the dedupe + window assembly is exercised for real.
 */
function makeRuntime(
	all: Memory[],
	recentWindow: Memory[],
	target: Memory | null,
	conversationLength = 50,
): IAgentRuntime {
	const byId = new Map(all.map((m) => [m.id, m]));
	return {
		agentId: AGENT_ID,
		character: { name: "Agent" },
		getConversationLength: vi.fn(() => conversationLength),
		getMemoriesByIds: vi.fn(async (ids: UUID[]) =>
			ids.map((id) => byId.get(id)).filter((m): m is Memory => Boolean(m)),
		),
		getMemories: vi.fn(
			async (params: {
				start?: number;
				end?: number;
				limit?: number;
				orderDirection?: "asc" | "desc";
			}) => {
				// Recent-window query: no bounds, newest-first.
				if (params.start === undefined && params.end === undefined) {
					return [...recentWindow].sort(
						(a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
					);
				}
				let rows = [...all];
				if (params.end !== undefined) {
					const end = params.end;
					rows = rows.filter((m) => (m.createdAt ?? 0) <= end);
				}
				if (params.start !== undefined) {
					const start = params.start;
					rows = rows.filter((m) => (m.createdAt ?? 0) >= start);
				}
				rows.sort((a, b) =>
					params.orderDirection === "asc"
						? (a.createdAt ?? 0) - (b.createdAt ?? 0)
						: (b.createdAt ?? 0) - (a.createdAt ?? 0),
				);
				return params.limit ? rows.slice(0, params.limit) : rows;
			},
		),
		getEntitiesForRoom: vi.fn(async () => [
			{ id: AGENT_ID, agentId: AGENT_ID, names: ["Agent"], components: [] },
			{ id: USER_ID, agentId: AGENT_ID, names: ["Alice"], components: [] },
		]),
		getEntityById: vi.fn(async () => null),
		...(target ? {} : {}),
	} as unknown as IAgentRuntime;
}

describe("replyContextProvider", () => {
	it("renders nothing when the incoming turn is not a reply", async () => {
		const incoming = mem("cur", USER_ID, "hi", 100);
		const result = await replyContextProvider.get(
			makeRuntime([], [], null),
			incoming,
			{ values: {}, data: {}, text: "" },
		);
		expect(result.text).toBe("");
		expect(result.data?.replyTargetMessage).toBeNull();
	});

	it("identifies the replied-to message and pulls the surrounding window", async () => {
		// A ten-turn thread; the reply targets the middle turn (t=500).
		const thread = Array.from({ length: 10 }, (_, i) =>
			mem(
				`m${i}`,
				i % 2 === 0 ? USER_ID : AGENT_ID,
				`turn ${i}`,
				(i + 1) * 100,
			),
		);
		const target = thread[4]; // t=500, "turn 4"
		// RECENT_MESSAGES only shows the tail (t>=900): the window around t=500 is
		// NOT already visible, so the provider must inject it.
		const recent = thread.filter((m) => (m.createdAt ?? 0) >= 900);
		const incoming = {
			...mem("cur", USER_ID, "about that", 1100),
			content: { text: "about that", source: "discord", inReplyTo: target.id },
		} as Memory;

		const result = await replyContextProvider.get(
			makeRuntime(thread, recent, target),
			incoming,
			{ values: {}, data: {}, text: "" },
		);

		// Identifies the target by sender + snippet.
		expect(result.text).toContain("direct reply to this earlier message");
		expect(result.text).toContain("turn 4");
		// Window: the target (t=500) plus RADIUS turns on each side — turns 1..7
		// (createdAt 200..800), none of which are in the recent tail (t>=900).
		const replyContextMessages = result.data?.replyContextMessages;
		expect(replyContextMessages).toBeDefined();
		if (!replyContextMessages) {
			throw new Error("Expected reply-context messages to be returned");
		}
		const windowIds = (replyContextMessages as Memory[]).map((m) => m.id);
		expect(windowIds).toContain(thread[1].id); // RADIUS older
		expect(windowIds).toContain(thread[4].id); // the target itself
		expect(windowIds).toContain(thread[7].id); // RADIUS newer
		// Symmetric radius: never reaches beyond RADIUS on either side.
		expect(windowIds).not.toContain(thread[0].id); // t=100, RADIUS+1 older
		expect(windowIds).not.toContain(thread[8].id); // t=900, in the recent tail
		// Both half-windows are [target, ±RADIUS]; merged unique that is
		// 2*RADIUS+1 turns (the shared target counted once).
		expect(replyContextMessages).toHaveLength(
			2 * REPLY_CONTEXT_WINDOW_RADIUS + 1,
		);
	});

	it("dedupes window turns already shown in the recent transcript", async () => {
		const thread = Array.from({ length: 8 }, (_, i) =>
			mem(
				`m${i}`,
				i % 2 === 0 ? USER_ID : AGENT_ID,
				`turn ${i}`,
				(i + 1) * 100,
			),
		);
		const target = thread[7]; // the last turn (t=800)
		// The window around the last turn is turns 4..7 (t=500..800); RECENT_MESSAGES
		// already shows all of t>=500, so the entire window overlaps it.
		const recent = thread.filter((m) => (m.createdAt ?? 0) >= 500);
		const incoming = {
			...mem("cur", USER_ID, "re", 900),
			content: { text: "re", source: "discord", inReplyTo: target.id },
		} as Memory;

		const result = await replyContextProvider.get(
			makeRuntime(thread, recent, target),
			incoming,
			{ values: {}, data: {}, text: "" },
		);

		// The surrounding turns are all in the recent transcript, so none are
		// re-rendered; the provider still identifies WHICH message was replied to.
		expect(result.data?.replyContextMessages).toHaveLength(0);
		expect(result.text).toContain("turn 7");
		expect(result.text).toContain("already appear in the recent conversation");
	});

	it("ignores a reply id that resolves to another room", async () => {
		const foreign = mem("foreign", USER_ID, "secret", 500, OTHER_ROOM_ID);
		const incoming = {
			...mem("cur", USER_ID, "leak?", 600),
			content: { text: "leak?", source: "discord", inReplyTo: foreign.id },
		} as Memory;

		const result = await replyContextProvider.get(
			makeRuntime([foreign], [], foreign),
			incoming,
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toBe("");
		expect(result.data?.replyTargetMessage).toBeNull();
	});

	it("renders nothing when the replied-to message no longer exists", async () => {
		const incoming = {
			...mem("cur", USER_ID, "?", 100),
			content: {
				text: "?",
				source: "discord",
				inReplyTo: "00000000-0000-0000-0000-0000000000ff",
			},
		} as Memory;

		const result = await replyContextProvider.get(
			makeRuntime([], [], null),
			incoming,
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toBe("");
	});
});

describe("truncateSingleLine", () => {
	it("keeps surrogate pairs intact at exact and max-plus-one bounds", () => {
		const exact = "hello🦊";
		expect(exact.length).toBe(7);
		expect(truncateSingleLine(exact, 7)).toBe(exact);

		const maxPlusOne = `${exact}b`;
		expect(maxPlusOne.length).toBe(8);
		const truncated = truncateSingleLine(maxPlusOne, 7);
		expect(truncated).toBe("hello…");
		expect(isWellFormed(truncated)).toBe(true);
		expect(truncated.length).toBeLessThanOrEqual(7);
	});

	it("sanitizes lone surrogates before truncation", () => {
		const lone = `a\uD800bcdef`;
		const truncated = truncateSingleLine(lone, 4);
		expect(truncated).toBe(`a�b…`);
		expect(isWellFormed(truncated)).toBe(true);
	});

	it("sanitizes either lone surrogate half without truncation", () => {
		for (const lone of [`a\uD800bc`, `a\uDC00bc`]) {
			const out = truncateSingleLine(lone, 10);
			expect(out).toBe(`a�bc`);
			expect(isWellFormed(out)).toBe(true);
		}
	});

	it("collapses whitespace and trims before well-formed check", () => {
		const text = `  hello   \n  world  `;
		const out = truncateSingleLine(text, 20);
		expect(out).toBe("hello world");
		expect(isWellFormed(out)).toBe(true);
	});

	it("honors the 300-char reply target cap and never emits lone surrogates", () => {
		const emoji = "🦊";
		const long =
			`a`.repeat(MAX_REPLY_TARGET_SNIPPET_CHARS - 1) + emoji + `b`.repeat(10);
		const out = truncateSingleLine(long, MAX_REPLY_TARGET_SNIPPET_CHARS);
		expect(out.length).toBeLessThanOrEqual(MAX_REPLY_TARGET_SNIPPET_CHARS);
		expect(out.endsWith("…")).toBe(true);
		expect(isWellFormed(out)).toBe(true);
	});
});

describe("withBoundedText", () => {
	it("keeps surrogate pairs intact at exact and max-plus-one window bounds", () => {
		const exact = `${`a`.repeat(MAX_REPLY_WINDOW_MESSAGE_CHARS - 2)}🦊`;
		const exactMemory = mem("m0", USER_ID, exact, 99);
		expect(exact.length).toBe(MAX_REPLY_WINDOW_MESSAGE_CHARS);
		expect(withBoundedText(exactMemory)).toBe(exactMemory);

		const maxPlusOne = `${exact}b`;
		expect(maxPlusOne.length).toBe(MAX_REPLY_WINDOW_MESSAGE_CHARS + 1);
		const bounded = withBoundedText(mem("m1", USER_ID, maxPlusOne, 100));
		const out = bounded.content.text as string;
		expect(out.length).toBeLessThanOrEqual(MAX_REPLY_WINDOW_MESSAGE_CHARS);
		expect(out.endsWith("…")).toBe(true);
		expect(isWellFormed(out)).toBe(true);
		expect(out).not.toContain("\uD83E");
	});

	it("sanitizes lone surrogates in window text", () => {
		const lone = `x\uD800${`y`.repeat(2000)}`;
		const bounded = withBoundedText(mem("m2", USER_ID, lone, 200));
		const out = bounded.content.text as string;
		expect(out).toContain("�");
		expect(isWellFormed(out)).toBe(true);
	});

	it("returns same reference when already well-formed and under limit", () => {
		const text = "short well-formed";
		const memory = mem("m3", USER_ID, text, 300);
		const bounded = withBoundedText(memory);
		expect(bounded).toBe(memory);
	});

	it("returns new memory with sanitized text when lone surrogate present under limit", () => {
		const lone = `ok \uD800 end`;
		const memory = mem("m4", USER_ID, lone, 400);
		const bounded = withBoundedText(memory);
		expect(bounded).not.toBe(memory);
		expect(bounded.content.text).toBe(`ok � end`);
		expect(isWellFormed(bounded.content.text as string)).toBe(true);
	});
});
