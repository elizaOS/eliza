/** Regression tests for counterexamples found by tla/FactWriteDedupe.tla. */
import {
	AgentRuntime,
	type Memory,
	MemoryType,
	type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, expect, test } from "vitest";

const ROOM_ID = "44444444-4444-4444-4444-444444444444" as UUID;
const ENTITY_ID = "55555555-5555-5555-5555-555555555555" as UUID;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createRuntime() {
	const runtime = new AgentRuntime({
		character: { name: "FactWriteDedupe" },
		logLevel: "fatal",
	});
	const adapter = SQLiteDatabaseAdapter.create(":memory:", runtime.agentId);
	runtime.registerDatabaseAdapter(adapter);
	await adapter.initialize();
	cleanups.push(async () => {
		await runtime.stop();
		await adapter.close();
	});
	return runtime;
}

function fact(evidenceId: string): Memory {
	return {
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "The user lives in Berlin", type: "fact" },
		metadata: {
			type: MemoryType.CUSTOM,
			extractionEvidenceIds: [evidenceId],
		},
	} as Memory;
}

async function facts(runtime: AgentRuntime) {
	return runtime.getMemories({
		tableName: "facts",
		roomId: ROOM_ID,
		count: 10,
		unique: false,
	});
}

// TLA+ NoDuplicateFact: concurrent identical fact writes (the detached
// facts stage of one turn overlapping the next turn's in the same room)
// leave one row.
test("concurrent identical fact writes store one row", async () => {
	const runtime = await createRuntime();
	const ids = await Promise.all([
		runtime.createMemory(fact("message-1"), "facts", true),
		runtime.createMemory(fact("message-2"), "facts", true),
	]);
	expect(await facts(runtime)).toHaveLength(1);
	expect(ids[0]).toBe(ids[1]);
});

// TLA+ NoLostEvidence: concurrent dedupe hits on one row keep every
// occurrence's evidence id.
test("concurrent dedupe hits keep every evidence id", async () => {
	const runtime = await createRuntime();
	await runtime.createMemory(fact("message-1"), "facts", true);
	await Promise.all([
		runtime.createMemory(fact("message-2"), "facts", true),
		runtime.createMemory(fact("message-3"), "facts", true),
	]);
	const [row] = await facts(runtime);
	expect(
		[
			...((row?.metadata as { extractionEvidenceIds?: string[] })
				?.extractionEvidenceIds ?? []),
		].sort(),
	).toEqual(["message-1", "message-2", "message-3"]);
});
