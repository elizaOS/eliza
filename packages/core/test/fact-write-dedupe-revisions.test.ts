/** Regression: a dedupe hit must not drop new source revisions when the
 * incoming occurrence carries no new evidence ids. */
import {
	AgentRuntime,
	type Memory,
	MemoryType,
	type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { mergeStrongerFactMetadata } from "../src/runtime/fact-write-dedupe";

const ROOM_ID = "44444444-4444-4444-4444-444444444444" as UUID;
const ENTITY_ID = "55555555-5555-5555-5555-555555555555" as UUID;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fact(metadata: Record<string, unknown>): Memory {
	return {
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "The user lives in Berlin", type: "fact" },
		metadata: { type: MemoryType.CUSTOM, ...metadata },
	} as Memory;
}

describe("mergeStrongerFactMetadata — source revisions", () => {
	test("merges new source revisions without new evidence ids", () => {
		const merged = mergeStrongerFactMetadata(
			fact({
				extractionEvidenceIds: ["e1"],
				extractionSourceRevisions: { srcA: 1 },
			}),
			fact({ extractionSourceRevisions: { srcB: 2 } }),
		);
		expect(
			(merged as Record<string, unknown> | null)?.extractionSourceRevisions,
		).toEqual({ srcA: 1, srcB: 2 });
	});

	test("returns null when the incoming revisions add nothing new", () => {
		expect(
			mergeStrongerFactMetadata(
				fact({
					extractionEvidenceIds: ["e1"],
					extractionSourceRevisions: { srcA: 1 },
				}),
				fact({ extractionSourceRevisions: { srcA: 1 } }),
			),
		).toBeNull();
	});
});

describe("fact dedupe — source revisions persist through SQLite", () => {
	test("a dedupe hit keeps the incoming source revision", async () => {
		const runtime = new AgentRuntime({
			character: { name: "FactWriteDedupeRevisions" },
			logLevel: "fatal",
		});
		const adapter = SQLiteDatabaseAdapter.create(":memory:", runtime.agentId);
		runtime.registerDatabaseAdapter(adapter);
		await adapter.initialize();
		cleanups.push(async () => {
			await runtime.stop();
			await adapter.close();
		});

		await runtime.createMemory(
			fact({
				extractionEvidenceIds: ["e1"],
				extractionSourceRevisions: { srcA: 1 },
			}),
			"facts",
			true,
		);
		await runtime.createMemory(
			fact({ extractionSourceRevisions: { srcB: 2 } }),
			"facts",
			true,
		);

		const rows = await runtime.getMemories({
			tableName: "facts",
			roomId: ROOM_ID,
			count: 10,
			unique: false,
		});
		expect(rows).toHaveLength(1);
		expect(
			(rows[0]?.metadata as Record<string, unknown>)
				.extractionSourceRevisions,
		).toEqual({ srcA: 1, srcB: 2 });
	});
});
