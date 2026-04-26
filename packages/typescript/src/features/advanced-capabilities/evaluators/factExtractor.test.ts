/**
 * Tests for the single-call fact extractor evaluator.
 *
 * Real PGLite via `@elizaos/plugin-sql` — no SQL mocks (per project
 * convention; see CLAUDE.md). The runtime model is stubbed via
 * `runtime.registerModel` so we control the JSON ops the extractor consumes,
 * and the embedding model is registered as a deterministic per-text vector
 * so write-time cosine dedup is exercised end-to-end.
 *
 * Covers:
 *   - per-category insertions (durable health, current feeling, life_event
 *     with structured_fields, multiple ops in one response)
 *   - strengthen: confidence bump + lastConfirmedAt + evidence append
 *   - decay: confidence drop and deletion below floor
 *   - contradict: row in fact_candidates, original fact preserved
 *   - write-time dedup: near-duplicate add_durable upgraded to strengthen
 *   - non-duplicate insert proceeds normally
 *   - invalid LLM output returns undefined and writes nothing
 *   - per-message validate() gating
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
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
import { factExtractorEvaluator } from "./factExtractor.ts";

const EMBED_DIM = 384;

/**
 * Pseudo-random but deterministic embedding seeded from the input text.
 * Two equal strings give the same vector; "lives in Berlin" and "lives in
 * Berlin, Germany" land near each other only when we register them as such
 * in the per-test model (see `withEmbeddingMap`).
 */
function fixedEmbedding(): number[] {
	return Array.from({ length: EMBED_DIM }, (_, i) => (i + 1) / EMBED_DIM);
}

/**
 * Build an embedding that is mostly the fixed one but flips a contiguous
 * window of dimensions to a different magnitude, so two such vectors can be
 * driven to a target cosine similarity by varying the window.
 *
 * Used by the "no dedup when dissimilar" test to produce a vector with low
 * cosine against the existing fact.
 */
function distinctEmbedding(): number[] {
	return Array.from({ length: EMBED_DIM }, (_, i) =>
		i % 2 === 0 ? -((i + 1) / EMBED_DIM) : (i + 1) / EMBED_DIM,
	);
}

interface Fixture {
	runtime: AgentRuntime;
	roomId: UUID;
	entityId: UUID;
	embeddingMap: Map<string, number[]>;
	defaultEmbedding: number[];
	cleanup: () => Promise<void>;
}

interface SetupOptions {
	modelResponses?: string[];
}

async function setup(options: SetupOptions = {}): Promise<Fixture> {
	const pgliteDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "fact-extractor-test-pglite-"),
	);
	const prevPgliteDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = pgliteDir;

	const character = createCharacter({ name: "ExtractorTestAgent" });
	const runtime = new AgentRuntime({
		character,
		plugins: [],
		logLevel: "warn",
		enableAutonomy: false,
	});

	const embeddingMap = new Map<string, number[]>();
	const defaultEmbedding = fixedEmbedding();

	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async (
			_runtime: unknown,
			params: Record<string, unknown> | string | null,
		) => {
			let text: string;
			if (typeof params === "string") {
				text = params;
			} else if (params && typeof params === "object" && "text" in params) {
				text = String((params as { text: unknown }).text ?? "");
			} else {
				text = "";
			}
			return embeddingMap.get(text) ?? defaultEmbedding;
		},
		"fact-extractor-test",
		10,
	);

	// Stub the small text model with canned responses (FIFO). Tests that need
	// custom behavior set `modelResponses` per-call.
	const responses = [...(options.modelResponses ?? [])];
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async () => {
			return responses.shift() ?? '{"ops":[]}';
		},
		"fact-extractor-test",
		10,
	);

	const { default: pluginSql } = await import("@elizaos/plugin-sql");
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();

	const roomId = runtime.agentId;
	const entityId = asUUID(stringToUuid(`fact-extractor-user-${Math.random()}`));
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

	return {
		runtime,
		roomId,
		entityId,
		embeddingMap,
		defaultEmbedding,
		cleanup,
	};
}

interface FactInsert {
	text: string;
	confidence: number;
	createdAt?: number;
	metadata?: FactMetadata;
	embedding?: number[];
}

async function insertFact(fx: Fixture, insert: FactInsert): Promise<UUID> {
	const id = asUUID(v4());
	const baseMeta: FactMetadata & { type: string; source: string } = {
		type: MemoryType.CUSTOM,
		source: "fact-extractor-test",
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
			embedding: insert.embedding ?? fx.defaultEmbedding,
			createdAt: insert.createdAt ?? Date.now(),
			metadata: baseMeta,
		},
		"facts",
		true,
	);
	return id;
}

function makeMessage(fx: Fixture, text: string): Memory {
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

async function listFacts(fx: Fixture): Promise<Memory[]> {
	return fx.runtime.getMemories({
		tableName: "facts",
		roomId: fx.roomId,
		limit: 100,
		unique: false,
	});
}

interface FactCandidateRow {
	kind: string;
	status: string;
	existing_fact_id: string | null;
	proposed_text: string;
}

async function listFactCandidates(fx: Fixture): Promise<FactCandidateRow[]> {
	const adapter = (fx.runtime as unknown as { adapter: { db: unknown } })
		.adapter;
	const db = adapter.db as {
		execute: (
			query: ReturnType<typeof sql.raw>,
		) => Promise<{ rows: FactCandidateRow[] } | unknown>;
	};
	const result = await db.execute(
		sql.raw(
			"SELECT kind, status, existing_fact_id::text AS existing_fact_id, proposed_text FROM fact_candidates",
		),
	);
	if (
		result &&
		typeof result === "object" &&
		"rows" in result &&
		Array.isArray((result as { rows: unknown }).rows)
	) {
		return (result as { rows: FactCandidateRow[] }).rows;
	}
	if (Array.isArray(result)) {
		return result as FactCandidateRow[];
	}
	return [];
}

describe("factExtractorEvaluator", () => {
	let fx: Fixture;

	afterEach(async () => {
		if (fx) await fx.cleanup();
	}, 60_000);

	it("inserts a durable health fact with category + confidence + verification status", async () => {
		fx = await setup({
			modelResponses: [
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "flat cortisol curve",
							category: "health",
							structured_fields: { condition: "flat cortisol curve" },
							verification_status: "confirmed",
						},
					],
				}),
			],
		});

		const result = await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "I have a flat cortisol curve"),
			emptyState,
		);
		expect(result?.success).toBe(true);
		expect(result?.values?.added).toBe(1);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(1);
		const meta = facts[0]?.metadata as FactMetadata | undefined;
		expect(meta?.kind).toBe("durable");
		expect(meta?.category).toBe("health");
		expect(meta?.confidence).toBeCloseTo(0.7, 5);
		expect(meta?.verificationStatus).toBe("confirmed");
		expect(facts[0]?.content.text).toBe("flat cortisol curve");
	}, 60_000);

	it("inserts a current feeling fact with validAt + lastConfirmedAt set", async () => {
		const validAt = "2026-04-25T10:00:00.000Z";
		fx = await setup({
			modelResponses: [
				JSON.stringify({
					ops: [
						{
							op: "add_current",
							claim: "anxious this morning",
							category: "feeling",
							structured_fields: { emotion: "anxious", window: "morning" },
							valid_at: validAt,
						},
					],
				}),
			],
		});

		await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "I'm anxious this morning"),
			emptyState,
		);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(1);
		const meta = facts[0]?.metadata as FactMetadata | undefined;
		expect(meta?.kind).toBe("current");
		expect(meta?.category).toBe("feeling");
		expect(meta?.validAt).toBe(validAt);
		expect(typeof meta?.lastConfirmedAt).toBe("string");
		expect(meta?.lastConfirmedAt?.length ?? 0).toBeGreaterThan(0);
	}, 60_000);

	it("persists structured_fields on durable life_event inserts", async () => {
		fx = await setup({
			modelResponses: [
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "moved to Berlin in March 2024",
							category: "life_event",
							structured_fields: {
								event: "relocation",
								destination: "Berlin",
								date: "2024-03-01",
							},
						},
					],
				}),
			],
		});

		await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "I moved to Berlin last March"),
			emptyState,
		);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(1);
		const meta = facts[0]?.metadata as FactMetadata | undefined;
		expect(meta?.structuredFields).toEqual({
			event: "relocation",
			destination: "Berlin",
			date: "2024-03-01",
		});
	}, 60_000);

	it("applies multiple ops from one response in order", async () => {
		fx = await setup({
			modelResponses: [
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "founded Acme in 2024",
							category: "life_event",
							structured_fields: { event: "founded company" },
						},
						{
							op: "add_durable",
							claim: "founder of Acme",
							category: "business_role",
							structured_fields: { role: "founder", company: "Acme" },
						},
					],
				}),
			],
		});

		const result = await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "I founded Acme in 2024"),
			emptyState,
		);
		expect(result?.values?.added).toBe(2);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(2);
		const categories = facts.map(
			(f) => (f.metadata as FactMetadata).category,
		);
		expect(categories).toEqual(
			expect.arrayContaining(["life_event", "business_role"]),
		);
	}, 60_000);

	it("strengthen: bumps confidence by 0.1 and updates lastConfirmedAt + evidence", async () => {
		fx = await setup();
		const factId = await insertFact(fx, {
			text: "lives in Berlin",
			confidence: 0.7,
			metadata: {
				kind: "durable",
				category: "identity",
				evidenceMessageIds: [],
			},
		});

		// Re-prime the model now that we know the inserted fact id.
		(fx.runtime as unknown as { models: Map<string, unknown[]> }).models.set(
			"TEXT_SMALL",
			[],
		);
		fx.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				return JSON.stringify({
					ops: [{ op: "strengthen", factId }],
				});
			},
			"fact-extractor-test",
			10,
		);

		const message = makeMessage(fx, "Berlin's been treating me well");
		await factExtractorEvaluator.handler(fx.runtime, message, emptyState);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(1);
		const meta = facts[0]?.metadata as FactMetadata | undefined;
		expect(meta?.confidence).toBeCloseTo(0.8, 5);
		expect(meta?.lastConfirmedAt).toBeTypeOf("string");
		expect(meta?.evidenceMessageIds).toContain(message.id);
	}, 60_000);

	it("decay: drops confidence by 0.15 when above floor", async () => {
		fx = await setup();
		const factId = await insertFact(fx, {
			text: "stuck on legacy migration",
			confidence: 0.8,
			metadata: {
				kind: "current",
				category: "working_on",
				validAt: new Date().toISOString(),
			},
		});

		(fx.runtime as unknown as { models: Map<string, unknown[]> }).models.set(
			"TEXT_SMALL",
			[],
		);
		fx.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				return JSON.stringify({
					ops: [{ op: "decay", factId }],
				});
			},
			"fact-extractor-test",
			10,
		);

		await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "we wrapped that one up"),
			emptyState,
		);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(1);
		const meta = facts[0]?.metadata as FactMetadata | undefined;
		expect(meta?.confidence).toBeCloseTo(0.65, 5);
	}, 60_000);

	it("decay: deletes the fact when confidence drops below the 0.2 floor", async () => {
		fx = await setup();
		const factId = await insertFact(fx, {
			text: "noisy upstairs neighbor",
			confidence: 0.25,
			metadata: {
				kind: "current",
				category: "going_through",
				validAt: new Date().toISOString(),
			},
		});

		(fx.runtime as unknown as { models: Map<string, unknown[]> }).models.set(
			"TEXT_SMALL",
			[],
		);
		fx.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				return JSON.stringify({
					ops: [{ op: "decay", factId }],
				});
			},
			"fact-extractor-test",
			10,
		);

		await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "they moved out"),
			emptyState,
		);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(0);
	}, 60_000);

	it("contradict: writes a row to fact_candidates and leaves the original fact in place", async () => {
		fx = await setup();
		const factId = await insertFact(fx, {
			text: "lives in Berlin",
			confidence: 0.85,
			metadata: { kind: "durable", category: "identity" },
		});

		(fx.runtime as unknown as { models: Map<string, unknown[]> }).models.set(
			"TEXT_SMALL",
			[],
		);
		fx.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				return JSON.stringify({
					ops: [
						{
							op: "contradict",
							factId,
							proposedText: "lives in Tokyo",
							reason: "user said they moved to Tokyo",
						},
					],
				});
			},
			"fact-extractor-test",
			10,
		);

		await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "actually I moved to Tokyo last month"),
			emptyState,
		);

		const candidates = await listFactCandidates(fx);
		expect(candidates.length).toBe(1);
		expect(candidates[0]?.kind).toBe("contradict");
		expect(candidates[0]?.status).toBe("pending");
		expect(candidates[0]?.existing_fact_id).toBe(factId);
		expect(candidates[0]?.proposed_text).toBe("lives in Tokyo");

		const facts = await listFacts(fx);
		expect(facts.length).toBe(1);
		expect(facts[0]?.id).toBe(factId);
	}, 60_000);

	it("write-time dedup: near-duplicate add_durable upgrades to strengthen against the existing fact", async () => {
		fx = await setup();
		const sharedEmbedding = fixedEmbedding();
		const existingId = await insertFact(fx, {
			text: "lives in Berlin",
			confidence: 0.7,
			metadata: {
				kind: "durable",
				category: "identity",
				evidenceMessageIds: [],
			},
			embedding: sharedEmbedding,
		});

		// Same embedding for the proposed claim → cosine == 1.
		fx.embeddingMap.set("lives in Berlin, Germany", sharedEmbedding);
		// And for the message text we feed in (the extractor embeds the message
		// before pulling candidates).
		fx.embeddingMap.set("I live in Berlin, Germany", sharedEmbedding);

		(fx.runtime as unknown as { models: Map<string, unknown[]> }).models.set(
			"TEXT_SMALL",
			[],
		);
		fx.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () =>
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "lives in Berlin, Germany",
							category: "identity",
							structured_fields: { location: "Berlin, Germany" },
						},
					],
				}),
			"fact-extractor-test",
			10,
		);

		const message = makeMessage(fx, "I live in Berlin, Germany");
		const result = await factExtractorEvaluator.handler(
			fx.runtime,
			message,
			emptyState,
		);
		expect(result?.values?.added).toBe(0);
		expect(result?.values?.strengthened).toBe(1);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(1);
		expect(facts[0]?.id).toBe(existingId);
		const meta = facts[0]?.metadata as FactMetadata | undefined;
		expect(meta?.confidence).toBeCloseTo(0.8, 5);
		expect(meta?.evidenceMessageIds).toContain(message.id);
	}, 60_000);

	it("write-time dedup: dissimilar add_durable proceeds as a normal insert", async () => {
		fx = await setup();
		const existingEmbedding = fixedEmbedding();
		await insertFact(fx, {
			text: "lives in Berlin",
			confidence: 0.7,
			metadata: { kind: "durable", category: "identity" },
			embedding: existingEmbedding,
		});

		// New claim has a strongly negative-correlated embedding → cosine well
		// below the 0.92 dedup threshold.
		const distinct = distinctEmbedding();
		fx.embeddingMap.set("allergic to penicillin", distinct);
		fx.embeddingMap.set("I'm allergic to penicillin", distinct);

		(fx.runtime as unknown as { models: Map<string, unknown[]> }).models.set(
			"TEXT_SMALL",
			[],
		);
		fx.runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () =>
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "allergic to penicillin",
							category: "health",
							structured_fields: { condition: "penicillin allergy" },
						},
					],
				}),
			"fact-extractor-test",
			10,
		);

		const result = await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "I'm allergic to penicillin"),
			emptyState,
		);
		expect(result?.values?.added).toBe(1);

		const facts = await listFacts(fx);
		expect(facts.length).toBe(2);
		const texts = facts.map((f) => f.content.text);
		expect(texts).toEqual(
			expect.arrayContaining(["lives in Berlin", "allergic to penicillin"]),
		);
	}, 60_000);

	it("returns undefined and writes nothing when the LLM returns invalid output", async () => {
		fx = await setup({
			modelResponses: ["this is not JSON, sorry"],
		});

		const result = await factExtractorEvaluator.handler(
			fx.runtime,
			makeMessage(fx, "hi there"),
			emptyState,
		);
		expect(result).toBeUndefined();

		const facts = await listFacts(fx);
		expect(facts.length).toBe(0);
	}, 60_000);

	it("validate(): same message processed twice → second validate returns false", async () => {
		fx = await setup({
			modelResponses: [JSON.stringify({ ops: [] })],
		});

		const message = makeMessage(fx, "hello");
		expect(
			await factExtractorEvaluator.validate(fx.runtime, message, emptyState),
		).toBe(true);

		await factExtractorEvaluator.handler(fx.runtime, message, emptyState);

		expect(
			await factExtractorEvaluator.validate(fx.runtime, message, emptyState),
		).toBe(false);
	}, 60_000);
});
