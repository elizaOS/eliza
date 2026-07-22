/**
 * Contract test for `AgentRuntime.countMemories`: the object form must forward
 * BOTH the `roomIds` param (the IAgentRuntime/adapter spelling every typed
 * caller uses) and the legacy `roomId` singular to the adapter. The
 * implementation previously read only `roomId`, silently dropping
 * interface-correct `roomIds` scoping — /reset reported the TABLE-WIDE count
 * ("cleared 31126 message(s)") for a 40-message room, and the compact action's
 * boundary math ran against the whole agent history.
 */

import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime";
import type { Character, IDatabaseAdapter, UUID } from "./types";

const ROOM = "cccccccc-0000-0000-0000-000000000001" as UUID;

function runtimeWithRecordingAdapter() {
	const runtime = new AgentRuntime({
		character: { name: "count-memories-test" } as Character,
	});
	const calls: Array<Record<string, unknown>> = [];
	runtime.registerDatabaseAdapter({
		countMemories: async (params: Record<string, unknown>) => {
			calls.push(params);
			return 7;
		},
	} as unknown as IDatabaseAdapter);
	return { runtime, calls };
}

describe("AgentRuntime.countMemories room scoping", () => {
	it("forwards roomIds (the adapter/interface spelling) to the adapter", async () => {
		const { runtime, calls } = runtimeWithRecordingAdapter();
		await runtime.countMemories({
			roomIds: [ROOM],
			tableName: "messages",
			unique: false,
		});
		expect(calls[0]?.roomIds).toEqual([ROOM]);
	});

	it("forwards the legacy singular roomId as a one-element roomIds", async () => {
		const { runtime, calls } = runtimeWithRecordingAdapter();
		await runtime.countMemories({ roomId: ROOM, tableName: "messages" });
		expect(calls[0]?.roomIds).toEqual([ROOM]);
	});

	it("forwards the bare-UUID form scoped to that room", async () => {
		const { runtime, calls } = runtimeWithRecordingAdapter();
		await runtime.countMemories(ROOM);
		expect(calls[0]?.roomIds).toEqual([ROOM]);
	});

	it("leaves roomIds undefined (table-wide) only when no room scope was given", async () => {
		const { runtime, calls } = runtimeWithRecordingAdapter();
		await runtime.countMemories({ tableName: "messages" });
		expect(calls[0]?.roomIds).toBeUndefined();
	});
});
