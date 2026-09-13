/**
 * The rendered dialogue window is bounded newest-first: RECENT_MESSAGES
 * supplies the complete room transcript, and rendering all of it re-read 400+
 * rows (~140K characters) on every Stage-1 call of a busy room (live
 * 2026-09-13). A note tells the model that older rows exist.
 */
import { describe, expect, it } from "vitest";
import type { ContextEvent } from "../../types/context-object";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	appendPriorDialogueEvents,
	applyPriorDialogueBudget,
} from "./dialogue-context";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;

function row(index: number, text: string, own = false): Memory {
	return {
		id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}` as UUID,
		entityId: own ? AGENT_ID : USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text, source: "test" },
		createdAt: 1_000 + index,
	} as Memory;
}

function stateWith(rows: Memory[]): State {
	return {
		values: {},
		text: "",
		data: {
			providers: { RECENT_MESSAGES: { data: { recentMessages: rows } } },
		},
	} as State;
}

const runtime = {
	agentId: AGENT_ID,
	character: { name: "Eliza" },
} as IAgentRuntime;

describe("applyPriorDialogueBudget", () => {
	it("keeps the newest rows up to the message limit and reports the rest", () => {
		const rows = Array.from({ length: 10 }, (_, i) => row(i, `m${i}`));
		expect(
			applyPriorDialogueBudget(rows, { maxMessages: 4, maxChars: 1_000 }),
		).toBe(6);
		expect(rows.map((r) => r.content.text)).toEqual(["m6", "m7", "m8", "m9"]);
	});

	it("stops at the character budget but always keeps the newest row", () => {
		const rows = [
			row(0, "x".repeat(50)),
			row(1, "y".repeat(50)),
			row(2, "z".repeat(80)),
		];
		expect(
			applyPriorDialogueBudget(rows, { maxMessages: 10, maxChars: 60 }),
		).toBe(2);
		expect(rows.map((r) => r.content.text)).toEqual(["z".repeat(80)]);
	});

	it("drops nothing when everything fits", () => {
		const rows = [row(0, "a"), row(1, "b")];
		expect(
			applyPriorDialogueBudget(rows, { maxMessages: 60, maxChars: 30_000 }),
		).toBe(0);
		expect(rows).toHaveLength(2);
	});
});

describe("appendPriorDialogueEvents window", () => {
	it("renders only the budgeted newest rows and prefixes an omission note", () => {
		const rows = Array.from({ length: 100 }, (_, i) => row(i, `line ${i}`));
		const current = row(999, "current");
		const events: ContextEvent[] = [];
		appendPriorDialogueEvents(events, runtime, stateWith(rows), current, {
			includeOwnReplies: true,
			maxMessages: 5,
			maxChars: 30_000,
		});
		const note = events.find((e) => e.id === "prior-dialogue-window");
		expect(note?.segment?.content).toContain("95 earlier message(s)");
		const history = events.filter((e) => e.id?.startsWith("history:"));
		expect(history).toHaveLength(5);
		expect(history[0]?.segment?.content).toContain("line 95");
		expect(history[4]?.segment?.content).toContain("line 99");
	});

	it("emits no note when the whole thread fits the default window", () => {
		const rows = Array.from({ length: 12 }, (_, i) => row(i, `line ${i}`));
		const events: ContextEvent[] = [];
		appendPriorDialogueEvents(
			events,
			runtime,
			stateWith(rows),
			row(999, "current"),
			{
				includeOwnReplies: true,
			},
		);
		expect(
			events.find((e) => e.id === "prior-dialogue-window"),
		).toBeUndefined();
		expect(events.filter((e) => e.id?.startsWith("history:"))).toHaveLength(12);
	});
});
