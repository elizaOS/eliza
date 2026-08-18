/**
 * Contract test for `AgentRuntime.getAllMemories` on a real runtime with a
 * recording adapter: the partition sweep must include every platform-owned
 * memory table — the media GC's referenced-set and clearAllAgentMemories both
 * depend on this list being complete (#14751: a partition missing here leaves
 * its media references invisible to the sweep) — must paginate each partition
 * to exhaustion rather than truncate at one bounded page (a truncated sweep
 * makes the GC delete still-referenced media).
 */

import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime";
import type { Character, IDatabaseAdapter, Memory, UUID } from "./types";

const TRANSCRIPT_ROW = {
	id: "aaaaaaaa-0000-0000-0000-000000000001" as UUID,
	entityId: "bbbbbbbb-0000-0000-0000-000000000001" as UUID,
	roomId: "cccccccc-0000-0000-0000-000000000001" as UUID,
	content: {
		transcript: JSON.stringify({
			id: "aaaaaaaa-0000-0000-0000-000000000001",
			audioUrl: "/api/media/deadbeef.wav",
		}),
	},
	metadata: { type: "custom", source: "transcript" },
} as Memory;

describe("AgentRuntime.getAllMemories", () => {
	it("sweeps the transcripts partition so transcript rows reach the media GC", async () => {
		const runtime = new AgentRuntime({
			character: { name: "get-all-memories-test" } as Character,
		});
		const sweptTables: string[] = [];
		runtime.registerDatabaseAdapter({
			getMemories: async (params: { tableName: string }) => {
				sweptTables.push(params.tableName);
				return params.tableName === "transcripts" ? [TRANSCRIPT_ROW] : [];
			},
		} as unknown as IDatabaseAdapter);

		const all = await runtime.getAllMemories();

		expect(sweptTables).toEqual([
			"memories",
			"messages",
			"facts",
			"documents",
			"transcripts",
		]);
		expect(all).toContain(TRANSCRIPT_ROW);
	});

	it("paginates a partition to exhaustion instead of truncating at one page", async () => {
		const runtime = new AgentRuntime({
			character: { name: "get-all-memories-paging-test" } as Character,
		});
		const pageRow = (page: number, count: number): Memory[] =>
			Array.from(
				{ length: count },
				(_, i) =>
					({
						id: `dddddddd-0000-0000-0000-${String(page * 10000 + i).padStart(12, "0")}`,
					}) as Memory,
			);
		const requestedOffsets: number[] = [];
		runtime.registerDatabaseAdapter({
			getMemories: async (params: { tableName: string; offset?: number }) => {
				if (params.tableName !== "messages") return [];
				const offset = params.offset ?? 0;
				requestedOffsets.push(offset);
				// Two full pages then a short one: 20,007 rows in the partition.
				if (offset === 0) return pageRow(0, 10000);
				if (offset === 10000) return pageRow(1, 10000);
				return pageRow(2, 7);
			},
		} as unknown as IDatabaseAdapter);

		const all = await runtime.getAllMemories();

		expect(requestedOffsets).toEqual([0, 10000, 20000]);
		expect(all).toHaveLength(20007);
	});
});
