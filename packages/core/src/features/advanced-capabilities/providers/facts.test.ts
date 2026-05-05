/**
 * Tests for the two-store facts provider (durable + current).
 *
 * Uses a real PGLite-backed runtime via `@elizaos/plugin-sql`; no SQL mocks
 * (per project convention — see CLAUDE.md). The runtime's `searchMemories`
 * does not accept metadata filters, so the provider over-fetches and
 * partitions in TS — these tests exercise the partition + ranking through
 * the real adapter end-to-end.
 *
 * Covers:
 *   - empty store → "No facts available."
 *   - durable-only / current-only / both sections render correctly
 *   - durable does not decay (year-old high-conf wins over fresh low-conf)
 *   - current decays (fresh low-conf wins over month-old high-conf)
 *   - 30d-old current is still retrievable when no younger competitors
 *   - legacy facts (no `kind`) treated as durable
 *   - mixed durable+current results split into correct sections
 *   - confidence formatted to two decimals
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCharacter } from "../../../character.ts";
import { AgentRuntime } from "../../../runtime.ts";
import type {
	FactMetadata,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { MemoryType, ModelType } from "../../../types/index.ts";
import { asUUID } from "../../../types/primitives.ts";
import { stringToUuid } from "../../../utils.ts";
import { factsProvider } from "./facts.ts";

const EMBED_DIM = 384;

/**
 * Deterministic fixed embedding so every fact + the query land at near-1
 * cosine similarity. This isolates the tests from similarity ranking and
 * lets us assert on the kind/confidence/age ranking the provider applies.
 */
function fixedEmbedding(): number[] {
	return Array.from({ length: EMBED_DIM }, (_, i) => (i + 1) / EMBED_DIM);
}

interface Fixture {
	runtime: AgentRuntime;
	roomId: UUID;
	entityId: UUID;
	cleanup: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
	const pgliteDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "facts-provider-test-pglite-"),
	);
	const prevPgliteDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = pgliteDir;

	const character = createCharacter({ name: "FactsTestAgent" });
	const runtime = new AgentRuntime({
		character,
		plugins: [],
		logLevel: "warn",
		enableAutonomy: false,
	});

	// Register a deterministic 384-dim embedding model BEFORE initialize so
	// the adapter can pin its embedding dimension during provisioning.
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => fixedEmbedding(),
		"facts-test",
		10,
	);

	const { default: pluginSql } = await import("@elizaos/plugin-sql");
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();

	// The runtime auto-provisions an agent-self room keyed on agentId; we
	// reuse that for fact + message scope so the foreign keys resolve.
	const roomId = runtime.agentId;

	// Create a sender entity so message.entityId resolves.
	const entityId = asUUID(stringToUuid(`facts-test-user-${Math.random()}`));
	await runtime.createEntity({
		id: entityId,
		names: ["Sam"],
		agentId: runtime.agentId,
	});

	const cleanup = async () => {
		try {
			await runtime.stop();
		} catch {}
		try {
			await runtime.close();
		} catch {}
		if (prevPgliteDir !== undefined) {
			process.env.PGLITE_DATA_DIR = prevPgliteDir;
		} else {
			delete process.env.PGLITE_DATA_DIR;
		}
		try {
			fs.rmSync(pgliteDir, { recursive: true, force: true });
		} catch {}
	};

	return { runtime, roomId, entityId, cleanup };
}

interface FactInsert {
	text: string;
	confidence: number;
	createdAt?: number;
	metadata?: FactMetadata;
}

async function insertFact(fx: Fixture, insert: FactInsert): Promise<UUID> {
	const id = asUUID(v4());
	const baseMeta: FactMetadata & { type: string; source: string } = {
		type: MemoryType.CUSTOM,
		source: "facts-test",
		confidence: insert.confidence,
		...(insert.metadata ?? {}),
	};
	await fx.runtime.createMemory(
		{
			id,
			entityId: fx.entityId,
			agentId: fx.runtime.agentId,
			roomId: fx.roomId,
			content: { text: insert.text },
			embedding: fixedEmbedding(),
			createdAt: insert.createdAt ?? Date.now(),
			metadata: baseMeta,
		},
		"facts",
		true,
	);
	return id;
}

function makeMessage(fx: Fixture, text = "what's going on?"): Memory {
	return {
		id: asUUID(v4()),
		entityId: fx.entityId,
		agentId: fx.runtime.agentId,
		roomId: fx.roomId,
		content: { text, senderName: "Sam" },
		createdAt: Date.now(),
	} satisfies Memory;
}

const emptyState: State = { values: {}, data: {}, text: "" };

describe("factsProvider (two-store)", () => {
	let fx: Fixture;

	// First-run migrations + service init can exceed vitest's default 10s
	// hook timeout on cold caches; bump generously so CI is not flaky.
	beforeEach(async () => {
		fx = await setup();
	}, 60_000);

	afterEach(async () => {
		await fx.cleanup();
	}, 60_000);

	it("returns 'No facts available.' when store is empty", async () => {
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		expect(result.text).toBe("No facts available.");
		const data = result.data as {
			facts: Memory[];
			durableFacts: Memory[];
			currentFacts: Memory[];
		};
		expect(data.facts).toEqual([]);
		expect(data.durableFacts).toEqual([]);
		expect(data.currentFacts).toEqual([]);
	});

	it("renders only the durable section when only durable facts exist", async () => {
		await insertFact(fx, {
			text: "lives in Berlin",
			confidence: 0.88,
			metadata: { kind: "durable", category: "identity" },
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		expect(result.text).toContain("Things FactsTestAgent knows about Sam:");
		expect(result.text).toContain(
			"[durable.identity conf=0.88] lives in Berlin",
		);
		expect(result.text).not.toContain("What's currently happening");
	});

	it("renders only the current section when only current facts exist", async () => {
		const validAt = "2026-04-25T00:00:00.000Z";
		await insertFact(fx, {
			text: "navigating divorce",
			confidence: 0.85,
			metadata: {
				kind: "current",
				category: "going_through",
				validAt,
			},
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		expect(result.text).toContain("What's currently happening for Sam:");
		expect(result.text).toContain(
			"[current.going_through since 2026-04-25 conf=0.85] navigating divorce",
		);
		expect(result.text).not.toContain("Things FactsTestAgent knows about Sam:");
	});

	it("renders both sections in order (durable first, then current)", async () => {
		await insertFact(fx, {
			text: "lives in Berlin",
			confidence: 0.88,
			metadata: { kind: "durable", category: "identity" },
		});
		await insertFact(fx, {
			text: "anxious this morning",
			confidence: 0.7,
			metadata: {
				kind: "current",
				category: "feeling",
				validAt: "2026-04-25T00:00:00.000Z",
			},
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		const text = result.text ?? "";
		const durableHeaderIdx = text.indexOf("Things FactsTestAgent knows about");
		const currentHeaderIdx = text.indexOf("What's currently happening for");
		expect(durableHeaderIdx).toBeGreaterThanOrEqual(0);
		expect(currentHeaderIdx).toBeGreaterThan(durableHeaderIdx);
		expect(text).toContain("[durable.identity conf=0.88] lives in Berlin");
		expect(text).toContain(
			"[current.feeling since 2026-04-25 conf=0.70] anxious this morning",
		);
	});

	it("does not decay durable facts: year-old higher-conf beats fresh lower-conf", async () => {
		const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
		await insertFact(fx, {
			text: "allergic to penicillin",
			confidence: 0.9,
			createdAt: yearAgo,
			metadata: { kind: "durable", category: "health" },
		});
		await insertFact(fx, {
			text: "drinks oat milk",
			confidence: 0.5,
			createdAt: Date.now(),
			metadata: { kind: "durable", category: "preference" },
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		const data = result.data as { durableFacts: Memory[] };
		expect(data.durableFacts.length).toBe(2);
		expect(data.durableFacts[0]?.content.text).toBe("allergic to penicillin");
		expect(data.durableFacts[1]?.content.text).toBe("drinks oat milk");
	});

	it("decays current facts: fresh lower-conf beats month-old higher-conf", async () => {
		const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		await insertFact(fx, {
			text: "old project blocker",
			confidence: 0.9,
			createdAt: monthAgo,
			metadata: {
				kind: "current",
				category: "working_on",
				validAt: new Date(monthAgo).toISOString(),
			},
		});
		await insertFact(fx, {
			text: "anxious this morning",
			confidence: 0.5,
			createdAt: Date.now(),
			metadata: {
				kind: "current",
				category: "feeling",
				validAt: new Date().toISOString(),
			},
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		const data = result.data as { currentFacts: Memory[] };
		expect(data.currentFacts.length).toBe(2);
		// 0.5 * 1.0 = 0.5 vs 0.9 * exp(-30/14) ≈ 0.9 * 0.117 ≈ 0.105
		expect(data.currentFacts[0]?.content.text).toBe("anxious this morning");
		expect(data.currentFacts[1]?.content.text).toBe("old project blocker");
	});

	it("still surfaces a 30-day-old current fact when no younger competitors exist", async () => {
		const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		await insertFact(fx, {
			text: "deadline Friday",
			confidence: 0.9,
			createdAt: monthAgo,
			metadata: {
				kind: "current",
				category: "schedule_context",
				validAt: new Date(monthAgo).toISOString(),
			},
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		const data = result.data as { currentFacts: Memory[] };
		expect(data.currentFacts.length).toBe(1);
		expect(data.currentFacts[0]?.content.text).toBe("deadline Friday");
		expect(result.text).toContain("[current.schedule_context");
		expect(result.text).toContain("deadline Friday");
	});

	it("treats legacy facts (no kind) as durable for backward compat", async () => {
		await insertFact(fx, {
			text: "prefers concise answers",
			confidence: 0.7,
			// No kind, no category — legacy shape from factRefinement.ts.
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		const data = result.data as {
			durableFacts: Memory[];
			currentFacts: Memory[];
		};
		expect(data.durableFacts.length).toBe(1);
		expect(data.currentFacts.length).toBe(0);
		expect(result.text).toContain(
			"[durable.uncategorized conf=0.70] prefers concise answers",
		);
		expect(result.text).not.toContain("What's currently happening");
	});

	it("partitions a mixed pool: 3 durable + 3 current → both sections show 3 each", async () => {
		const today = new Date().toISOString();
		// Durable
		await insertFact(fx, {
			text: "lives in Berlin",
			confidence: 0.9,
			metadata: { kind: "durable", category: "identity" },
		});
		await insertFact(fx, {
			text: "allergic to penicillin",
			confidence: 0.85,
			metadata: { kind: "durable", category: "health" },
		});
		await insertFact(fx, {
			text: "founded indie studio in 2024",
			confidence: 0.8,
			metadata: { kind: "durable", category: "life_event" },
		});
		// Current
		await insertFact(fx, {
			text: "anxious this morning",
			confidence: 0.75,
			metadata: { kind: "current", category: "feeling", validAt: today },
		});
		await insertFact(fx, {
			text: "drafting Q4 plan",
			confidence: 0.7,
			metadata: { kind: "current", category: "working_on", validAt: today },
		});
		await insertFact(fx, {
			text: "deadline Friday",
			confidence: 0.65,
			metadata: {
				kind: "current",
				category: "schedule_context",
				validAt: today,
			},
		});

		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		const data = result.data as {
			durableFacts: Memory[];
			currentFacts: Memory[];
		};
		expect(data.durableFacts.length).toBe(3);
		expect(data.currentFacts.length).toBe(3);

		const durableLines = data.durableFacts.map((memory) => memory.content.text);
		expect(durableLines).toEqual(
			expect.arrayContaining([
				"lives in Berlin",
				"allergic to penicillin",
				"founded indie studio in 2024",
			]),
		);

		const currentLines = data.currentFacts.map((memory) => memory.content.text);
		expect(currentLines).toEqual(
			expect.arrayContaining([
				"anxious this morning",
				"drafting Q4 plan",
				"deadline Friday",
			]),
		);

		const text = result.text ?? "";
		// Every durable line carries the durable prefix; every current line the current prefix.
		for (const t of durableLines) {
			expect(text).toMatch(
				new RegExp(`\\[durable\\.[a-z_]+ conf=0\\.\\d{2}\\] ${t}`),
			);
		}
		for (const t of currentLines) {
			expect(text).toMatch(
				new RegExp(
					`\\[current\\.[a-z_]+ since \\d{4}-\\d{2}-\\d{2} conf=0\\.\\d{2}\\] ${t}`,
				),
			);
		}
	});

	it("formats confidence to exactly two decimals (no trailing-zero stripping)", async () => {
		await insertFact(fx, {
			text: "always struggles with mornings",
			confidence: 0.9, // → "0.90"
			metadata: { kind: "durable", category: "health" },
		});
		await insertFact(fx, {
			text: "navigating divorce",
			confidence: 0.92, // → "0.92"
			metadata: {
				kind: "current",
				category: "going_through",
				validAt: "2026-04-25T00:00:00.000Z",
			},
		});
		const result = await factsProvider.get(
			fx.runtime,
			makeMessage(fx),
			emptyState,
		);
		const text = result.text ?? "";
		expect(text).toContain("conf=0.90");
		expect(text).toContain("conf=0.92");
		expect(text).not.toContain("conf=0.9 ");
		expect(text).not.toContain("conf=0.9]");
	});
});
