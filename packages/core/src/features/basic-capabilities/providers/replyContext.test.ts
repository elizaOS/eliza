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
	normalizeSingleLine,
	replyContextProvider,
	withWellFormedText,
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
		// Every retained turn outside the recent tail is included.
		const replyContextMessages = result.data?.replyContextMessages;
		expect(replyContextMessages).toBeDefined();
		if (!replyContextMessages) {
			throw new Error("Expected reply-context messages to be returned");
		}
		const windowIds = (replyContextMessages as Memory[]).map((m) => m.id);
		expect(windowIds).toContain(thread[0].id);
		expect(windowIds).toContain(thread[4].id); // the target itself
		expect(windowIds).toContain(thread[7].id);
		expect(windowIds).not.toContain(thread[8].id); // t=900, in the recent tail
		expect(replyContextMessages).toHaveLength(8);
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

		// The recent tail is deduped while every older retained turn is supplied.
		expect(result.data?.replyContextMessages).toHaveLength(4);
		expect(result.text).toContain("turn 7");
		expect(result.text).toContain("turn 0");
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

describe("normalizeSingleLine", () => {
	it("preserves complete text while normalizing whitespace and Unicode", () => {
		const text = `  ${"a".repeat(2_000)}🦊  \n  tail\uD800  `;
		const out = normalizeSingleLine(text);
		expect(out).toBe(`${"a".repeat(2_000)}🦊 tail�`);
		expect(isWellFormed(out)).toBe(true);
	});
});

describe("withWellFormedText", () => {
	it("preserves long content and repairs lone surrogates", () => {
		const lone = `ok \uD800 ${"x".repeat(2_000)}`;
		const memory = mem("m4", USER_ID, lone, 400);
		const normalized = withWellFormedText(memory);
		expect(normalized.content.text).toBe(`ok � ${"x".repeat(2_000)}`);
		expect(isWellFormed(normalized.content.text as string)).toBe(true);
	});
});
