/**
 * End-to-end scenario coverage for the two-store fact memory pipeline.
 *
 * Companion suite to `factExtractor.test.ts` (which covers per-op semantics)
 * and `providers/facts.test.ts` (which covers ranking in isolation). This
 * file is the integration layer: the extractor populates real PGLite via
 * `@elizaos/plugin-sql`, then the provider blends the two stores back out.
 *
 * Patterns:
 *   - No SQL mocks (per project convention; see CLAUDE.md). PGLite is the
 *     real adapter end-to-end.
 *   - `useModel(TEXT_SMALL)` is stubbed per scenario with the exact JSON op
 *     payload the extractor schema expects.
 *   - `useModel(TEXT_EMBEDDING)` is stubbed via a per-text map so we can
 *     drive write-time cosine similarity to known values.
 *   - Time-weighting scenarios manually set `createdAt` (and `validAt`)
 *     in the past via `runtime.createMemory({ createdAt: ... })` rather
 *     than mocking `Date.now()`. The provider uses a real `Date.now()` and
 *     subtracts the stored timestamp, so this is sufficient.
 *
 * Covers:
 *   - Categorization across the full taxonomy (durable.health/identity/
 *     life_event/business_role + current.feeling/working_on/going_through),
 *     including verification_status, structured_fields, multi-op responses
 *     in a single LLM call, and "today's been rough" → current.feeling
 *     (NOT durable).
 *   - Dedup at write time (same kind+category upgrades to strengthen,
 *     cross-category does NOT dedup, two near-duplicate ops in one
 *     response → second becomes strengthen against the first).
 *   - Time-weight read path (current decays, durable does not, single
 *     30-day-old current is still surfaced).
 *   - Strengthen/contradict end-to-end (confidence bump, fact_candidates
 *     row for contradict, supersession via separate insert rather than
 *     auto-retire).
 *   - Provider blending after the extractor populates the store, with
 *     deterministic ordering across repeated calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "../../../character.ts";
import { AgentRuntime } from "../../../runtime.ts";
import type {
	EmbeddingGenerationPayload,
	FactMetadata,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { EventType, MemoryType, ModelType } from "../../../types/index.ts";
import { asUUID } from "../../../types/primitives.ts";
import { stringToUuid } from "../../../utils.ts";
import { factsProvider } from "../providers/facts.ts";
import { factExtractorEvaluator } from "./factExtractor.ts";

const EMBED_DIM = 384;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deterministic baseline embedding used as the default when no per-text
 * vector is registered. Two facts that resolve to this default both
 * cosine-1, so this is the "everything matches everything" baseline that
 * isolates dedup tests from incidental similarity drift.
 */
function fixedEmbedding(): number[] {
	return Array.from({ length: EMBED_DIM }, (_, i) => (i + 1) / EMBED_DIM);
}

/**
 * Build a vector that is strongly anti-correlated with `fixedEmbedding`,
 * giving a cosine well below the 0.92 dedup threshold. Used by the
 * cross-category test (#14) to keep the embedding-dedup pathway from
 * intervening even though we deliberately stub similar embeddings.
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
	queueModelResponse: (response: string) => void;
	cleanup: () => Promise<void>;
}

interface SetupOptions {
	modelResponses?: string[];
	defaultEmbeddingFn?: () => number[];
	/**
	 * When `true`, register a synchronous embedding listener that writes the
	 * generated embedding straight back onto the row via `updateMemory`. The
	 * production embedding service (basic-capabilities plugin) does the same
	 * asynchronously through a batch queue; we are not loading that plugin
	 * in these unit tests, so without this stand-in the inserted facts have
	 * no embedding and `searchMemories` returns nothing — which breaks the
	 * provider read path. Off by default to keep the per-op extractor tests
	 * fast and free of event-loop coupling.
	 */
	persistEmbeddings?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<Fixture> {
	const pgliteDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "fact-memory-scenarios-pglite-"),
	);
	const prevPgliteDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = pgliteDir;

	const character = createCharacter({ name: "ScenarioAgent" });
	const runtime = new AgentRuntime({
		character,
		plugins: [],
		logLevel: "warn",
		enableAutonomy: false,
	});

	const embeddingMap = new Map<string, number[]>();
	const defaultEmbedding = (options.defaultEmbeddingFn ?? fixedEmbedding)();

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
		"fact-memory-scenarios",
		10,
	);

	const responses: string[] = [...(options.modelResponses ?? [])];
	const queueModelResponse = (response: string) => {
		responses.push(response);
	};
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async () => {
			return responses.shift() ?? '{"ops":[]}';
		},
		"fact-memory-scenarios",
		10,
	);

	const { default: pluginSql } = await import("@elizaos/plugin-sql");
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();

	if (options.persistEmbeddings) {
		runtime.registerEvent(
			EventType.EMBEDDING_GENERATION_REQUESTED,
			async (payload: EmbeddingGenerationPayload) => {
				const { memory } = payload;
				if (!memory.id || !memory.content?.text) return;
				const text = memory.content.text;
				const embedding = embeddingMap.get(text) ?? defaultEmbedding;
				await runtime.updateMemory({ id: memory.id, embedding });
			},
		);
	}

	const roomId = runtime.agentId;
	const entityId = asUUID(stringToUuid(`scenarios-user-${Math.random()}`));
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
		queueModelResponse,
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
		source: "fact-memory-scenarios",
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

function readMeta(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function assertExtractorCount(
	result: { values?: { added?: number; strengthened?: number } } | undefined,
	expected: { added?: number; strengthened?: number },
): void {
	expect(result).toBeDefined();
	if (expected.added !== undefined) {
		expect(result?.values?.added).toBe(expected.added);
	}
	if (expected.strengthened !== undefined) {
		expect(result?.values?.strengthened).toBe(expected.strengthened);
	}
}

describe("fact-memory scenarios", () => {
	let fx: Fixture;

	afterEach(async () => {
		if (fx) await fx.cleanup();
	}, 60_000);

	// ============================================================
	// Categorization scenarios — one per row in the spec table.
	// ============================================================

	describe("categorization", () => {
		it("'flat cortisol curve confirmed via lab' → durable.health, verification_status=confirmed, structured fields", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_durable",
								claim: "flat cortisol curve",
								category: "health",
								structured_fields: { verification_method: "lab_test" },
								verification_status: "confirmed",
							},
						],
					}),
				],
			});

			const result = await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I have a flat cortisol curve confirmed via lab"),
				emptyState,
			);
			assertExtractorCount(result, { added: 1 });

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			expect(meta.kind).toBe("durable");
			expect(meta.category).toBe("health");
			expect(meta.verificationStatus).toBe("confirmed");
			expect(meta.structuredFields).toEqual({
				verification_method: "lab_test",
			});
		}, 60_000);

		it("'I'm anxious this morning' → current.feeling with validAt set", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_current",
								claim: "anxious this morning",
								category: "feeling",
								structured_fields: { emotion: "anxious", window: "morning" },
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
			const meta = readMeta(facts[0]!);
			expect(meta.kind).toBe("current");
			expect(meta.category).toBe("feeling");
			expect(typeof meta.validAt).toBe("string");
			expect((meta.validAt ?? "").length).toBeGreaterThan(0);
		}, 60_000);

		it("'I moved to Berlin last March' → durable.life_event AND durable.identity (two ops)", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_durable",
								claim: "moved to Berlin in March",
								category: "life_event",
								structured_fields: {
									event: "relocation",
									destination: "Berlin",
									date: "2026-03-01",
								},
							},
							{
								op: "add_durable",
								claim: "lives in Berlin",
								category: "identity",
								structured_fields: { location: "Berlin" },
							},
						],
					}),
				],
			});

			// Distinct embeddings so write-time dedup does not collapse the two
			// inserts (same kind, but different categories so dedup wouldn't
			// fire anyway — this guard isolates the test from that path).
			fx.embeddingMap.set("moved to Berlin in March", fixedEmbedding());
			fx.embeddingMap.set("lives in Berlin", distinctEmbedding());

			const result = await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I moved to Berlin last March"),
				emptyState,
			);
			assertExtractorCount(result, { added: 2 });

			const facts = await listFacts(fx);
			expect(facts.length).toBe(2);
			const categories = facts.map((f) => readMeta(f).category).sort();
			expect(categories).toEqual(["identity", "life_event"]);
			for (const fact of facts) {
				expect(readMeta(fact).kind).toBe("durable");
			}
		}, 60_000);

		it("'Currently debugging the auth flow' → current.working_on", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_current",
								claim: "debugging the auth flow",
								category: "working_on",
								structured_fields: { task: "debugging", subject: "auth flow" },
							},
						],
					}),
				],
			});

			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "Currently debugging the auth flow"),
				emptyState,
			);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			expect(meta.kind).toBe("current");
			expect(meta.category).toBe("working_on");
		}, 60_000);

		it("'Going through a divorce' → current.going_through", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_current",
								claim: "navigating a divorce",
								category: "going_through",
								structured_fields: { situation: "divorce" },
							},
						],
					}),
				],
			});

			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "Going through a divorce"),
				emptyState,
			);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			expect(meta.kind).toBe("current");
			expect(meta.category).toBe("going_through");
		}, 60_000);

		it("'Founded Acme in 2024' → durable.life_event + durable.business_role", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_durable",
								claim: "founded Acme in 2024",
								category: "life_event",
								structured_fields: {
									event: "founded company",
									company: "Acme",
									year: 2024,
								},
							},
							{
								op: "add_durable",
								claim: "founder of Acme",
								category: "business_role",
								structured_fields: {
									role: "founder",
									company: "Acme",
									since: 2024,
								},
							},
						],
					}),
				],
			});

			fx.embeddingMap.set("founded Acme in 2024", fixedEmbedding());
			fx.embeddingMap.set("founder of Acme", distinctEmbedding());

			const result = await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "Founded Acme in 2024"),
				emptyState,
			);
			assertExtractorCount(result, { added: 2 });

			const facts = await listFacts(fx);
			expect(facts.length).toBe(2);
			const categories = facts.map((f) => readMeta(f).category).sort();
			expect(categories).toEqual(["business_role", "life_event"]);
		}, 60_000);

		it("'Allergic to penicillin' → durable.health", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_durable",
								claim: "allergic to penicillin",
								category: "health",
								structured_fields: {
									condition: "penicillin allergy",
									type: "allergy",
								},
							},
						],
					}),
				],
			});

			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "Allergic to penicillin"),
				emptyState,
			);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			expect(meta.kind).toBe("durable");
			expect(meta.category).toBe("health");
		}, 60_000);

		it("'Today's been rough' → current.feeling, NOT durable", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_current",
								claim: "today's been rough",
								category: "feeling",
								structured_fields: { emotion: "rough", window: "today" },
							},
						],
					}),
				],
			});

			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "Today's been rough"),
				emptyState,
			);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			expect(meta.kind).toBe("current");
			expect(meta.kind).not.toBe("durable");
			expect(meta.category).toBe("feeling");
		}, 60_000);

		it("'I always struggle with mornings' → durable.health with structured_fields.pattern='recurring'", async () => {
			fx = await setup({
				modelResponses: [
					JSON.stringify({
						ops: [
							{
								op: "add_durable",
								claim: "always struggles with mornings",
								category: "health",
								structured_fields: {
									pattern: "recurring",
									window: "mornings",
								},
							},
						],
					}),
				],
			});

			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I always struggle with mornings"),
				emptyState,
			);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			expect(meta.kind).toBe("durable");
			expect(meta.category).toBe("health");
			expect(meta.structuredFields).toMatchObject({ pattern: "recurring" });
		}, 60_000);
	});

	// ============================================================
	// Dedup scenarios — write-time embedding similarity within
	// `kind` + `category` upgrades add_* to strengthen.
	// ============================================================

	describe("dedup", () => {
		it("(13) same claim, different wording, similar embedding → second invocation upgrades to strengthen", async () => {
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

			// Drive cosine ≥ 0.92 by giving the proposed claim and the message
			// text the same embedding the existing fact has.
			fx.embeddingMap.set("user lives in Berlin, Germany", sharedEmbedding);
			fx.embeddingMap.set(
				"User mentioned again that they live in Berlin, Germany",
				sharedEmbedding,
			);

			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "user lives in Berlin, Germany",
							category: "identity",
							structured_fields: { location: "Berlin, Germany" },
						},
					],
				}),
			);

			const message = makeMessage(
				fx,
				"User mentioned again that they live in Berlin, Germany",
			);
			const result = await factExtractorEvaluator.handler(
				fx.runtime,
				message,
				emptyState,
			);
			assertExtractorCount(result, { added: 0, strengthened: 1 });

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			expect(facts[0]?.id).toBe(existingId);
			const meta = readMeta(facts[0]!);
			expect(meta.confidence).toBeCloseTo(0.8, 5);
			expect(typeof meta.lastConfirmedAt).toBe("string");
			expect(meta.evidenceMessageIds).toContain(message.id);
		}, 60_000);

		it("(14) same kind, DIFFERENT category → no dedup, separate row inserted", async () => {
			fx = await setup();
			const sharedEmbedding = fixedEmbedding();

			// Existing identity fact.
			const identityId = await insertFact(fx, {
				text: "lives in Berlin",
				confidence: 0.85,
				metadata: { kind: "durable", category: "identity" },
				embedding: sharedEmbedding,
			});

			// New health claim, deliberately given the same embedding so that the
			// only thing keeping dedup from firing is the category check.
			fx.embeddingMap.set("has insomnia", sharedEmbedding);
			fx.embeddingMap.set("I have insomnia", sharedEmbedding);

			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "has insomnia",
							category: "health",
							structured_fields: { condition: "insomnia" },
						},
					],
				}),
			);

			const result = await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I have insomnia"),
				emptyState,
			);
			assertExtractorCount(result, { added: 1, strengthened: 0 });

			const facts = await listFacts(fx);
			expect(facts.length).toBe(2);

			const identity = facts.find((f) => f.id === identityId);
			const health = facts.find((f) => readMeta(f).category === "health");
			expect(identity).toBeDefined();
			expect(health).toBeDefined();

			// The original identity row must be untouched by the new health insert.
			const identityMeta = readMeta(identity!);
			expect(identityMeta.confidence).toBeCloseTo(0.85, 5);
			expect(identityMeta.category).toBe("identity");

			const healthMeta = readMeta(health!);
			expect(healthMeta.kind).toBe("durable");
			expect(healthMeta.category).toBe("health");
		}, 60_000);

		it("(15) two near-duplicate ops in one LLM response → first inserts, second upgrades to strengthen against the first", async () => {
			fx = await setup();
			const sharedEmbedding = fixedEmbedding();

			// Both proposed claims share the same embedding (and the message
			// text they extract from). The first hits an empty pool and inserts;
			// the second has the just-inserted fact in `insertedThisRun` and
			// must dedup against it.
			fx.embeddingMap.set("anxious this morning", sharedEmbedding);
			fx.embeddingMap.set("feeling anxious today", sharedEmbedding);
			fx.embeddingMap.set(
				"I'm anxious this morning, feeling anxious today",
				sharedEmbedding,
			);

			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "add_current",
							claim: "anxious this morning",
							category: "feeling",
							structured_fields: { emotion: "anxious" },
						},
						{
							op: "add_current",
							claim: "feeling anxious today",
							category: "feeling",
							structured_fields: { emotion: "anxious" },
						},
					],
				}),
			);

			const result = await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I'm anxious this morning, feeling anxious today"),
				emptyState,
			);
			assertExtractorCount(result, { added: 1, strengthened: 1 });

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			// The strengthen against the just-inserted row bumps 0.7 → 0.8.
			expect(meta.confidence).toBeCloseTo(0.8, 5);
		}, 60_000);
	});

	// ============================================================
	// Time-weighting scenarios — verify the read path's per-kind
	// weighting after the store has been populated.
	// ============================================================

	describe("time weighting (read path)", () => {
		it("(16) two current.feeling facts: today (lower conf) wins over 30-day-old (higher conf)", async () => {
			fx = await setup();
			const monthAgoMs = Date.now() - 30 * MS_PER_DAY;

			await insertFact(fx, {
				text: "old anxious feeling",
				confidence: 0.7,
				createdAt: monthAgoMs,
				metadata: {
					kind: "current",
					category: "feeling",
					validAt: new Date(monthAgoMs).toISOString(),
				},
			});
			await insertFact(fx, {
				text: "new feeling today",
				confidence: 0.6,
				createdAt: Date.now(),
				metadata: {
					kind: "current",
					category: "feeling",
					validAt: new Date().toISOString(),
				},
			});

			const result = await factsProvider.get(
				fx.runtime,
				makeMessage(fx, "what's going on?"),
				emptyState,
			);
			const data = result.data as { currentFacts: Memory[] };
			expect(data.currentFacts.length).toBe(2);
			// 0.6 * 1.0 = 0.6 vs 0.7 * exp(-30/14) ≈ 0.7 * 0.117 ≈ 0.082 → today wins.
			expect(data.currentFacts[0]?.content.text).toBe("new feeling today");
			expect(data.currentFacts[1]?.content.text).toBe("old anxious feeling");
		});

		it("(17) two durable.health facts: 365-day-old (conf=0.9) wins over today (conf=0.5) — durable does not decay", async () => {
			fx = await setup();
			const yearAgoMs = Date.now() - 365 * MS_PER_DAY;

			await insertFact(fx, {
				text: "year-old established condition",
				confidence: 0.9,
				createdAt: yearAgoMs,
				metadata: { kind: "durable", category: "health" },
			});
			await insertFact(fx, {
				text: "fresh low-confidence claim",
				confidence: 0.5,
				createdAt: Date.now(),
				metadata: { kind: "durable", category: "health" },
			});

			const result = await factsProvider.get(
				fx.runtime,
				makeMessage(fx, "tell me about my health"),
				emptyState,
			);
			const data = result.data as { durableFacts: Memory[] };
			expect(data.durableFacts.length).toBe(2);
			// 0.9 * 1.0 = 0.9 vs 0.5 * 1.0 = 0.5 → year-old wins.
			expect(data.durableFacts[0]?.content.text).toBe(
				"year-old established condition",
			);
			expect(data.durableFacts[1]?.content.text).toBe(
				"fresh low-confidence claim",
			);
		});

		it("(18) lone 30-day-old current fact is still included (non-zero weight, no hard cutoff)", async () => {
			fx = await setup();
			const monthAgoMs = Date.now() - 30 * MS_PER_DAY;

			await insertFact(fx, {
				text: "deadline next month",
				confidence: 0.85,
				createdAt: monthAgoMs,
				metadata: {
					kind: "current",
					category: "schedule_context",
					validAt: new Date(monthAgoMs).toISOString(),
				},
			});

			const result = await factsProvider.get(
				fx.runtime,
				makeMessage(fx, "what's my schedule like?"),
				emptyState,
			);
			const data = result.data as { currentFacts: Memory[] };
			expect(data.currentFacts.length).toBe(1);
			expect(data.currentFacts[0]?.content.text).toBe("deadline next month");
			// Provider always renders sections that have any rows; the line should
			// still appear in the formatted output.
			expect(result.text).toContain("deadline next month");
			expect(result.text).toContain("[current.schedule_context");
		});
	});

	// ============================================================
	// Strengthen / contradict end-to-end.
	// ============================================================

	describe("strengthen / contradict", () => {
		it("(19) strengthen op against existing durable.health fact: confidence 0.7→0.8, lastConfirmedAt set, evidence appended", async () => {
			fx = await setup();
			const factId = await insertFact(fx, {
				text: "flat cortisol curve",
				confidence: 0.7,
				metadata: {
					kind: "durable",
					category: "health",
					evidenceMessageIds: [],
				},
			});

			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "strengthen",
							factId,
							reason: "user reaffirmed cortisol curve",
						},
					],
				}),
			);

			const message = makeMessage(
				fx,
				"my cortisol curve is still flat per the latest test",
			);
			await factExtractorEvaluator.handler(fx.runtime, message, emptyState);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			const meta = readMeta(facts[0]!);
			expect(meta.confidence).toBeCloseTo(0.8, 5);
			expect(typeof meta.lastConfirmedAt).toBe("string");
			expect((meta.lastConfirmedAt ?? "").length).toBeGreaterThan(0);
			expect(meta.evidenceMessageIds).toContain(message.id);
		}, 60_000);

		it("(20) contradict op against existing durable.identity fact: row in fact_candidates pending, original fact untouched", async () => {
			fx = await setup();
			const factId = await insertFact(fx, {
				text: "lives in Berlin",
				confidence: 0.85,
				metadata: { kind: "durable", category: "identity" },
			});

			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "contradict",
							factId,
							proposedText: "lives in Tokyo",
							reason: "user said they moved to Tokyo",
						},
					],
				}),
			);

			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "actually I moved to Tokyo"),
				emptyState,
			);

			const candidates = await listFactCandidates(fx);
			expect(candidates.length).toBe(1);
			expect(candidates[0]?.kind).toBe("contradict");
			expect(candidates[0]?.status).toBe("pending");
			expect(candidates[0]?.existing_fact_id).toBe(factId);
			expect(candidates[0]?.proposed_text).toBe("lives in Tokyo");

			// Original Berlin fact is preserved (no auto-delete, no auto-decay).
			const facts = await listFacts(fx);
			expect(facts.length).toBe(1);
			expect(facts[0]?.id).toBe(factId);
			expect(facts[0]?.content.text).toBe("lives in Berlin");
			const meta = readMeta(facts[0]!);
			expect(meta.confidence).toBeCloseTo(0.85, 5);
		}, 60_000);

		it("(21) supersession by add_current rather than auto-retire: closure leaves the old current fact alongside the new one", async () => {
			fx = await setup();
			const oldId = await insertFact(fx, {
				text: "debugging auth flow",
				confidence: 0.75,
				metadata: {
					kind: "current",
					category: "working_on",
					validAt: new Date().toISOString(),
				},
			});

			// Distinct embedding so write-time dedup does not collapse the new
			// "fixed" fact onto the old one.
			fx.embeddingMap.set("auth bug fixed today", distinctEmbedding());
			fx.embeddingMap.set("fixed the auth bug", distinctEmbedding());

			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "add_current",
							claim: "auth bug fixed today",
							category: "working_on",
							structured_fields: { task: "completed", subject: "auth bug" },
						},
					],
				}),
			);

			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "fixed the auth bug"),
				emptyState,
			);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(2);
			const old = facts.find((f) => f.id === oldId);
			const newer = facts.find((f) => f.id !== oldId);
			expect(old).toBeDefined();
			expect(newer).toBeDefined();
			expect(old?.content.text).toBe("debugging auth flow");
			expect(newer?.content.text).toBe("auth bug fixed today");
			expect(readMeta(newer!).category).toBe("working_on");
		}, 60_000);
	});

	// ============================================================
	// Provider blending end-to-end (extractor populates → provider reads).
	// ============================================================

	describe("provider blending", () => {
		it("(22) durable.health + durable.identity + current.feeling render in the right two sections with kind/category prefixes", async () => {
			fx = await setup({ persistEmbeddings: true });

			// Use distinct embeddings per claim so that dedup never fires and
			// each insert lands as a separate row even though our fixture's
			// default embedding would otherwise collide them.
			fx.embeddingMap.set("flat cortisol curve", fixedEmbedding());
			fx.embeddingMap.set("lives in Berlin", distinctEmbedding());
			const feelingEmbedding = Array.from(
				{ length: EMBED_DIM },
				(_, i) => i / EMBED_DIM,
			);
			fx.embeddingMap.set("anxious this morning", feelingEmbedding);
			fx.embeddingMap.set(
				"I have a flat cortisol curve confirmed via lab",
				fixedEmbedding(),
			);
			fx.embeddingMap.set("I live in Berlin", distinctEmbedding());
			fx.embeddingMap.set("I'm anxious this morning", feelingEmbedding);

			// First message: durable.health
			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "flat cortisol curve",
							category: "health",
							structured_fields: { verification_method: "lab_test" },
							verification_status: "confirmed",
						},
					],
				}),
			);
			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I have a flat cortisol curve confirmed via lab"),
				emptyState,
			);

			// Second message: durable.identity
			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "add_durable",
							claim: "lives in Berlin",
							category: "identity",
							structured_fields: { location: "Berlin" },
						},
					],
				}),
			);
			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I live in Berlin"),
				emptyState,
			);

			// Third message: current.feeling
			fx.queueModelResponse(
				JSON.stringify({
					ops: [
						{
							op: "add_current",
							claim: "anxious this morning",
							category: "feeling",
							structured_fields: { emotion: "anxious" },
						},
					],
				}),
			);
			await factExtractorEvaluator.handler(
				fx.runtime,
				makeMessage(fx, "I'm anxious this morning"),
				emptyState,
			);

			const facts = await listFacts(fx);
			expect(facts.length).toBe(3);

			const result = await factsProvider.get(
				fx.runtime,
				makeMessage(fx, "tell me about me"),
				emptyState,
			);

			const text = result.text ?? "";
			const durableHeaderIdx = text.indexOf(
				"Things ScenarioAgent knows about Sam:",
			);
			const currentHeaderIdx = text.indexOf(
				"What's currently happening for Sam:",
			);
			expect(durableHeaderIdx).toBeGreaterThanOrEqual(0);
			expect(currentHeaderIdx).toBeGreaterThan(durableHeaderIdx);

			expect(text).toMatch(
				/\[durable\.health conf=0\.\d{2}\] flat cortisol curve/,
			);
			expect(text).toMatch(
				/\[durable\.identity conf=0\.\d{2}\] lives in Berlin/,
			);
			expect(text).toMatch(
				/\[current\.feeling since \d{4}-\d{2}-\d{2} conf=0\.\d{2}\] anxious this morning/,
			);

			const data = result.data as {
				durableFacts: Memory[];
				currentFacts: Memory[];
			};
			expect(data.durableFacts.length).toBe(2);
			expect(data.currentFacts.length).toBe(1);
			const durableTexts = data.durableFacts.map((m) => m.content.text);
			expect(durableTexts).toEqual(
				expect.arrayContaining(["flat cortisol curve", "lives in Berlin"]),
			);
			expect(data.currentFacts[0]?.content.text).toBe("anxious this morning");
		}, 60_000);

		it("(23) provider stability: two consecutive get() calls return byte-identical formatted output", async () => {
			fx = await setup();

			// Set the store up directly — extractor pathway not relevant for this
			// determinism check, but the data shape mirrors what it would write.
			await insertFact(fx, {
				text: "lives in Berlin",
				confidence: 0.88,
				metadata: { kind: "durable", category: "identity" },
			});
			await insertFact(fx, {
				text: "allergic to penicillin",
				confidence: 0.85,
				metadata: { kind: "durable", category: "health" },
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

			const message = makeMessage(fx, "tell me about me");
			const first = await factsProvider.get(fx.runtime, message, emptyState);
			const second = await factsProvider.get(fx.runtime, message, emptyState);

			expect(typeof first.text).toBe("string");
			expect(second.text).toBe(first.text);

			const firstData = first.data as {
				durableFacts: Memory[];
				currentFacts: Memory[];
			};
			const secondData = second.data as {
				durableFacts: Memory[];
				currentFacts: Memory[];
			};
			expect(secondData.durableFacts.map((m) => m.id)).toEqual(
				firstData.durableFacts.map((m) => m.id),
			);
			expect(secondData.currentFacts.map((m) => m.id)).toEqual(
				firstData.currentFacts.map((m) => m.id),
			);
		});
	});
});
