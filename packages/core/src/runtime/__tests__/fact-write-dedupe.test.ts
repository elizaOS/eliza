/**
 * Structural write-time dedupe for the `facts` table, driven through a real
 * AgentRuntime + InMemoryDatabaseAdapter (only the extraction model output is
 * canned via registerModel). Regression-proves the live double-write: one
 * extraction turn persisted the same claim twice — a fact row (kind=current)
 * plus a relationship-echo row with no `kind`, which the FACTS reader then
 * promoted to a durable fact ("nubs plays guitar" duplicated durable).
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { factsProvider } from "../../features/advanced-capabilities/providers/facts";
import { AgentRuntime } from "../../runtime";
import { ChannelType, type Character, ModelType } from "../../types";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { State } from "../../types/state";
import { runFactsAndRelationshipsStage } from "../facts-and-relationships";

const USER = "00000000-0000-0000-0000-000000000001" as UUID;
const OTHER_USER = "00000000-0000-0000-0000-000000000009" as UUID;
const ROOM = "00000000-0000-0000-0000-000000000003" as UUID;
const JAKE = "00000000-0000-0000-0000-0000000000a1" as UUID;

function makeRuntime(modelResponse?: string): AgentRuntime {
	const runtime = new AgentRuntime({
		character: { name: "Eliza", bio: "test", settings: {} } as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	if (modelResponse !== undefined) {
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => modelResponse,
			"test",
			0,
		);
	}
	return runtime;
}

// The facts stage now sources room entities directly via getEntityDetails
// (getRoom + getEntitiesForRoom) instead of scraping the Stage-1 provider
// state (#13196). Seed the room + its participant entities so name->UUID
// grounding (nubs, Jake) resolves through the real adapter, matching how it
// works in production.
async function seedRoomEntities(runtime: AgentRuntime): Promise<void> {
	await runtime.createRooms([
		{
			id: ROOM,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.GROUP,
		},
	]);
	await runtime.createEntities([
		{ id: USER, agentId: runtime.agentId, names: ["nubs"], metadata: {} },
		{ id: JAKE, agentId: runtime.agentId, names: ["Jake"], metadata: {} },
	]);
	await runtime.createRoomParticipants([USER, JAKE], ROOM);
}

function makeMessage(runtime: AgentRuntime, text: string): Memory {
	return {
		id: crypto.randomUUID() as UUID,
		entityId: USER,
		agentId: runtime.agentId,
		roomId: ROOM,
		content: { text, source: "test" },
		createdAt: Date.now(),
	};
}

function makeState(): State {
	return {
		values: {},
		data: {
			providers: {
				ENTITIES: {
					data: {
						entities: [
							{ id: USER, names: ["nubs"] },
							{ id: JAKE, names: ["Jake"] },
						],
					},
				},
			},
		},
		text: "",
	};
}

function makeFact(
	text: string,
	entityId: UUID = USER,
	metadata?: Memory["metadata"],
): Memory {
	return {
		id: crypto.randomUUID() as UUID,
		entityId,
		agentId: undefined as unknown as UUID,
		roomId: ROOM,
		content: { text, type: "fact" },
		createdAt: Date.now(),
		...(metadata ? { metadata } : {}),
	};
}

async function readFactRows(runtime: AgentRuntime): Promise<Memory[]> {
	return runtime.getMemories({
		tableName: "facts",
		roomId: ROOM,
		count: 100,
		unique: false,
	});
}

describe("fact write-time dedupe (runtime.createMemory)", () => {
	it("skips an equivalent fact insert even when unique:true is passed", async () => {
		const runtime = makeRuntime();
		const firstId = await runtime.createMemory(
			makeFact("nubs plays guitar"),
			"facts",
			true,
		);
		const secondId = await runtime.createMemory(
			makeFact("Nubs plays guitar."),
			"facts",
			true,
		);
		expect(secondId).toBe(firstId);
		const rows = await readFactRows(runtime);
		expect(rows).toHaveLength(1);
	});

	it("keeps same-text facts from different entities (scope preserved)", async () => {
		const runtime = makeRuntime();
		await runtime.createMemory(makeFact("plays guitar", USER), "facts", true);
		await runtime.createMemory(
			makeFact("plays guitar", OTHER_USER),
			"facts",
			true,
		);
		expect(await readFactRows(runtime)).toHaveLength(2);
	});

	it("never treats empty normalized text as equivalent", async () => {
		const runtime = makeRuntime();
		await runtime.createMemory(makeFact("!!!"), "facts", true);
		await runtime.createMemory(makeFact("???"), "facts", true);
		expect(await readFactRows(runtime)).toHaveLength(2);
	});

	it("a duplicate with stronger metadata upgrades the kept row", async () => {
		const runtime = makeRuntime();
		const firstId = await runtime.createMemory(
			makeFact("nubs plays guitar", USER, {
				type: "custom",
				source: "facts_and_relationships_stage",
				kind: "current",
				confidence: 0.4,
				validAt: "2026-07-01T00:00:00.000Z",
			}),
			"facts",
			true,
		);
		const secondId = await runtime.createMemory(
			makeFact("Nubs plays guitar.", USER, {
				type: "custom",
				confidence: 0.9,
				validAt: "2026-07-04T00:00:00.000Z",
			}),
			"facts",
			true,
		);
		expect(secondId).toBe(firstId);
		const rows = await readFactRows(runtime);
		expect(rows).toHaveLength(1);
		const meta = rows[0].metadata as Record<string, unknown>;
		expect(meta.confidence).toBe(0.9);
		expect(meta.validAt).toBe("2026-07-04T00:00:00.000Z");
		// Untouched kept-row fields survive the upgrade.
		expect(meta.kind).toBe("current");
		expect(meta.source).toBe("facts_and_relationships_stage");
	});

	it("a duplicate with weaker metadata is a plain skip", async () => {
		const runtime = makeRuntime();
		await runtime.createMemory(
			makeFact("nubs plays guitar", USER, {
				type: "custom",
				kind: "durable",
				confidence: 0.9,
				validAt: "2026-07-04T00:00:00.000Z",
			}),
			"facts",
			true,
		);
		await runtime.createMemory(
			makeFact("nubs plays guitar", USER, {
				type: "custom",
				kind: "current",
				confidence: 0.4,
				validAt: "2026-07-01T00:00:00.000Z",
			}),
			"facts",
			true,
		);
		const rows = await readFactRows(runtime);
		expect(rows).toHaveLength(1);
		const meta = rows[0].metadata as Record<string, unknown>;
		expect(meta.confidence).toBe(0.9);
		// An already-set kind is never flipped by a duplicate.
		expect(meta.kind).toBe("durable");
		expect(meta.validAt).toBe("2026-07-04T00:00:00.000Z");
	});

	it("an explicit kind fills a kept row that has none", async () => {
		const runtime = makeRuntime();
		await runtime.createMemory(
			makeFact("nubs plays guitar", USER, { type: "custom" }),
			"facts",
			true,
		);
		await runtime.createMemory(
			makeFact("nubs plays guitar", USER, { type: "custom", kind: "current" }),
			"facts",
			true,
		);
		const rows = await readFactRows(runtime);
		expect(rows).toHaveLength(1);
		expect((rows[0].metadata as Record<string, unknown>).kind).toBe("current");
	});
});

describe("facts_and_relationships stage — no duplicate durable echo", () => {
	const GUITAR_OUTPUT = JSON.stringify({
		facts: ["nubs plays guitar"],
		relationships: [{ subject: "nubs", predicate: "plays", object: "guitar" }],
		thought: "new fact",
	});

	it("one turn emitting a fact plus its relationship echo lands ONE facts row", async () => {
		// Live symptom: the fact row and the relationship-echo row landed 5ms
		// apart with identical text — the echo must be structurally skipped.
		const runtime = makeRuntime(GUITAR_OUTPUT);
		await seedRoomEntities(runtime);
		await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(runtime, "i play guitar btw"),
			state: makeState(),
			extract: {
				facts: ["nubs plays guitar"],
				relationships: [
					{ subject: "nubs", predicate: "plays", object: "guitar" },
				],
			},
		});
		const rows = await readFactRows(runtime);
		expect(rows.map((row) => row.content.text)).toEqual(["nubs plays guitar"]);
	});

	it("extracting the same fact in two turns yields ONE facts row", async () => {
		// The per-turn LLM dedupe pool is advisory (the model can miss); the
		// structural write guard must hold even when it does.
		const runtime = makeRuntime(GUITAR_OUTPUT);
		await seedRoomEntities(runtime);
		for (let turn = 0; turn < 2; turn += 1) {
			await runFactsAndRelationshipsStage({
				runtime,
				message: makeMessage(runtime, "i play guitar btw"),
				state: makeState(),
				extract: { facts: ["nubs plays guitar"] },
			});
		}
		expect(await readFactRows(runtime)).toHaveLength(1);
	});

	it("a relationship echo is stamped current and never read back as durable", async () => {
		const runtime = makeRuntime(
			JSON.stringify({
				facts: [],
				relationships: [
					{ subject: "nubs", predicate: "has_sibling", object: "Jake" },
				],
				thought: "new rel",
			}),
		);
		await seedRoomEntities(runtime);
		await runFactsAndRelationshipsStage({
			runtime,
			message: makeMessage(runtime, "Jake is my brother"),
			state: makeState(),
			extract: {
				relationships: [
					{ subject: "nubs", predicate: "has_sibling", object: "Jake" },
				],
			},
		});

		const rows = await readFactRows(runtime);
		expect(rows).toHaveLength(1);
		const meta = rows[0].metadata as Record<string, unknown>;
		expect(meta.kind).toBe("current");
		expect(meta.confidence).toBe(0.6);
		expect(meta.verificationStatus).toBe("self_reported");

		// Read back through the real FACTS provider: the echo must rank as a
		// current fact, not get promoted to the durable section (the reader
		// defaults missing `kind` to durable).
		const result = await factsProvider.get(
			runtime,
			makeMessage(runtime, "does nubs have a sibling named Jake?"),
			makeState(),
		);
		const data = result.data as {
			durableFacts: Memory[];
			currentFacts: Memory[];
		};
		expect(data.durableFacts).toHaveLength(0);
		expect(data.currentFacts.map((row) => row.content.text)).toEqual([
			"nubs has_sibling Jake",
		]);
	});
});
