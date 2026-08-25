/**
 * Ordering contract of `loadDialogueWindow` in the group-conversation signal
 * provider: the returned window must stay chronological (oldest first) and must
 * stay chronological even when an adapter row carries a non-finite `createdAt`.
 * Deterministic harness — the runtime is a stub whose `getMemories` returns the
 * fixture rows; no DB, no model calls.
 */

import { describe, expect, it } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { loadDialogueWindow } from "./group-conversation-signals.ts";

const ROOM_ID = "00000000-0000-0000-0000-0000000000ff" as UUID;

function memory(id: string, createdAt: number | undefined): Memory {
	return {
		id: `00000000-0000-0000-0000-0000000000${id}` as UUID,
		entityId: "00000000-0000-0000-0000-00000000000e" as UUID,
		roomId: ROOM_ID,
		createdAt,
		content: { text: `turn ${id}` },
	} as Memory;
}

function stateWithRecentMessages(messages: Memory[]): State {
	return {
		values: {},
		data: {
			providers: {
				RECENT_MESSAGES: { data: { recentMessages: messages } },
			},
		},
		text: "",
	} as unknown as State;
}

/** Only `getMemories` is reachable from `loadDialogueWindow` in these cases. */
function stubRuntime(rows: Memory[]): IAgentRuntime {
	return {
		getMemories: async () => rows,
	} as unknown as IAgentRuntime;
}

const inbound = memory("aa", 500);

function ids(window: Memory[]): string[] {
	return window.map((entry) => String(entry.id).slice(-2));
}

describe("loadDialogueWindow ordering", () => {
	it("returns the composed window oldest-first", async () => {
		const window = await loadDialogueWindow(
			stubRuntime([]),
			inbound,
			stateWithRecentMessages([
				memory("03", 30),
				memory("01", 10),
				memory("02", 20),
			]),
		);
		expect(ids(window)).toEqual(["01", "02", "03", "aa"]);
	});

	it("keeps chronological order when a row carries a non-finite createdAt", async () => {
		// `01` must move ahead of `03`/`02`; a raw subtraction comparator yields
		// NaN for every pair touching it, so the misplaced row never moves.
		const window = await loadDialogueWindow(
			stubRuntime([]),
			inbound,
			stateWithRecentMessages([
				memory("03", 30),
				memory("01", Number.NaN),
				memory("02", 20),
			]),
		);
		expect(ids(window)).toEqual(["01", "02", "03", "aa"]);
	});

	it("keeps the live inbound turn last on the fallback room scan", async () => {
		const window = await loadDialogueWindow(
			stubRuntime([
				memory("03", 30),
				memory("01", Number.NaN),
				memory("02", 20),
			]),
			inbound,
			stateWithRecentMessages([]),
		);
		expect(ids(window)).toEqual(["01", "02", "03", "aa"]);
		expect(window[window.length - 1]?.id).toBe(inbound.id);
	});

	it("breaks equal timestamps deterministically by id", async () => {
		const window = await loadDialogueWindow(
			stubRuntime([]),
			inbound,
			stateWithRecentMessages([memory("0b", 10), memory("0a", 10)]),
		);
		expect(ids(window)).toEqual(["0a", "0b", "aa"]);
	});
});
