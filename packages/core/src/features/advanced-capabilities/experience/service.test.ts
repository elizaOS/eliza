/**
 * Unit tests for the ExperienceService CRUD/query surface: record normalization
 * and embedding wiring, defensive clones on reads, update pinning of immutable
 * fields, index removal on delete, filter/sort/access-tracking semantics,
 * duplicate-learning merges, analysis metrics, contradiction graph links, and
 * shutdown persistence. Drives the real service over the in-memory mock runtime
 * — no live model, no real DB, no embedder mocking (semantic search is covered
 * by service.findSimilar.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Memory } from "../../../types/memory.ts";
import { ModelType } from "../../../types/model.ts";
import type { UUID } from "../../../types/primitives.ts";
import { ExperienceService } from "./service.ts";
import { ExperienceType, OutcomeType } from "./types.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

// Recent enough that every seeded record sits inside the 7-day decay grace
// period, so decayed confidence equals stored confidence and quality sorts are
// exactly confidence * importance.
const BASE_TIME = Date.now() - 60_000;

let seedCounter = 0;
function uniqueId(): UUID {
	seedCounter += 1;
	return `00000000-0000-0000-0000-${String(seedCounter).padStart(12, "0")}` as UUID;
}

interface SeedFields {
	id?: UUID;
	type?: ExperienceType;
	outcome?: OutcomeType;
	context?: string;
	action?: string;
	result?: string;
	learning?: string;
	domain?: string;
	tags?: string[];
	keywords?: string[];
	confidence?: number;
	importance?: number;
	createdAt?: number;
	accessCount?: number;
	lastAccessedAt?: number;
	embedding?: number[];
	relatedExperiences?: UUID[];
	associatedEntityIds?: UUID[];
	supersedes?: UUID;
	mergedExperienceIds?: UUID[];
	correctedBelief?: string;
}

function experienceSeed(fields: SeedFields = {}): Memory {
	const id = fields.id ?? uniqueId();
	const createdAt = fields.createdAt ?? BASE_TIME;
	const data = {
		id,
		agentId: AGENT_ID,
		type: fields.type ?? ExperienceType.LEARNING,
		outcome: fields.outcome ?? OutcomeType.NEUTRAL,
		context: fields.context ?? "ctx",
		action: fields.action ?? "act",
		result: fields.result ?? "res",
		learning: fields.learning ?? "seeded learning",
		domain: fields.domain ?? "general",
		tags: fields.tags ?? ["t"],
		keywords: fields.keywords ?? ["k"],
		associatedEntityIds: fields.associatedEntityIds ?? [],
		confidence: fields.confidence ?? 0.8,
		importance: fields.importance ?? 0.7,
		createdAt,
		updatedAt: createdAt,
		accessCount: fields.accessCount ?? 0,
		...(fields.lastAccessedAt !== undefined
			? { lastAccessedAt: fields.lastAccessedAt }
			: {}),
		embedding: fields.embedding ?? [0.1, 0.2, 0.3],
		...(fields.relatedExperiences
			? { relatedExperiences: fields.relatedExperiences }
			: {}),
		...(fields.supersedes ? { supersedes: fields.supersedes } : {}),
		...(fields.mergedExperienceIds
			? { mergedExperienceIds: fields.mergedExperienceIds }
			: {}),
		...(fields.correctedBelief
			? { correctedBelief: fields.correctedBelief }
			: {}),
	};
	return {
		id,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: AGENT_ID,
		createdAt,
		content: {
			text: `Experience: ${data.learning}`,
			type: "experience",
			data,
		},
		embedding: data.embedding,
	};
}

function makeRuntime(memories: Memory[] = []) {
	const useModel = vi.fn(async () => [1, 2, 3]);
	const upsertMemory = vi.fn(async () => true);
	const deleteMemory = vi.fn(async () => true);
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		getMemories: vi.fn(async () => memories),
		upsertMemory,
		deleteMemory,
		useModel,
		reportError: vi.fn(),
	});
	return { runtime, useModel, upsertMemory, deleteMemory };
}

describe("ExperienceService.recordExperience", () => {
	it("applies defaults and derived facets when only a learning is provided", async () => {
		const { runtime } = makeRuntime();
		const service = await ExperienceService.start(runtime);
		const entityA = uniqueId();
		const entityB = uniqueId();

		const recorded = await service.recordExperience({
			learning: "retry failed network requests",
			domain: "network",
			associatedEntityIds: [entityA, entityA, entityB],
		});

		expect(recorded.type).toBe(ExperienceType.LEARNING);
		expect(recorded.outcome).toBe(OutcomeType.NEUTRAL);
		expect(recorded.confidence).toBe(0.5);
		expect(recorded.importance).toBe(0.5);
		expect(recorded.accessCount).toBe(0);
		expect(typeof recorded.lastAccessedAt).toBe("number");
		// No tags provided: defaults to [domain.toLowerCase(), type].
		expect(recorded.tags).toEqual(["network", "learning"]);
		// Keywords derived from learning + domain + default tags; frequency then
		// alphabetical ordering puts the thrice-seen domain term first.
		expect(recorded.keywords).toEqual([
			"network",
			"failed",
			"learning",
			"requests",
			"retry",
		]);
		// Duplicate associated entities collapse to a single entry.
		expect(recorded.associatedEntityIds).toEqual([entityA, entityB]);

		await service.stop();
	});

	it("normalizes provided tags but preserves explicit keyword casing and order", async () => {
		const { runtime } = makeRuntime();
		const service = await ExperienceService.start(runtime);

		const recorded = await service.recordExperience({
			tags: ["Ops", "ops", " OPS "],
			keywords: ["Cache", "cache", "Cache"],
		});

		expect(recorded.tags).toEqual(["ops"]);
		expect(recorded.keywords).toEqual(["Cache", "cache"]);

		await service.stop();
	});

	it("embeds once through the runtime model with all four text fields", async () => {
		const { runtime, useModel } = makeRuntime();
		const service = await ExperienceService.start(runtime);

		const recorded = await service.recordExperience({
			context: "c1",
			action: "a1",
			result: "r1",
			learning: "l1",
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING, {
			text: "c1 a1 r1 l1",
		});
		expect(recorded.embedding).toEqual([1, 2, 3]);

		await service.stop();
	});

	it("cross-links same-action opposite-outcome records in one domain as contradicts", async () => {
		const { runtime } = makeRuntime();
		const service = await ExperienceService.start(runtime);

		const success = await service.recordExperience({
			action: "deploy service",
			outcome: OutcomeType.POSITIVE,
			domain: "ops",
			learning: "deploys need health checks",
		});
		// Guarantee a distinct createdAt so the newer failure record sorts first
		// in the graph (its time weight is strictly higher) and link directions
		// are deterministic even when both quality scores tie at 0.25.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const failure = await service.recordExperience({
			action: "deploy service",
			outcome: OutcomeType.NEGATIVE,
			domain: "ops",
			learning: "deploys can fail without rollback",
		});

		const graph = await service.getExperienceGraph();

		expect(graph.totalExperiences).toBe(2);
		expect(graph.nodes.map((node) => node.id).sort()).toEqual(
			[success.id, failure.id].sort(),
		);
		// Two links: the stored contradicts relationship (strength 0.8) ranks
		// above the inferred supports link that arises because the identical
		// action/domain plus the shared defaulted "learning" tag yield four
		// common keywords (strength = min(0.85, 0.4 + 4 * 0.1) = 0.8).
		expect(graph.links.map((link) => link.type)).toEqual([
			"contradicts",
			"supports",
		]);
		expect(graph.links[0]).toMatchObject({
			sourceId: failure.id,
			targetId: success.id,
			type: "contradicts",
			strength: 0.8,
			reason: "stored contradicts relationship",
		});
		// The inferred link walks pairs newest-first, so the newer failure
		// record is the source of the supports link.
		expect(graph.links[1]).toMatchObject({
			sourceId: failure.id,
			targetId: success.id,
			type: "supports",
			strength: 0.8,
			reason: "shared domain keywords",
		});

		await service.stop();
	});
});

describe("ExperienceService reads and hydration", () => {
	it("returns null for a missing id and a defensive clone for an existing one", async () => {
		const seed = experienceSeed({ confidence: 0.8, tags: ["t"] });
		const { runtime } = makeRuntime([seed]);
		const service = await ExperienceService.start(runtime);

		await expect(service.getExperience(uniqueId())).resolves.toBeNull();

		const fetched = await service.getExperience(seed.id as UUID);
		expect(fetched).toMatchObject({ id: seed.id });
		fetched?.tags.push("mutated");
		if (fetched) {
			fetched.confidence = 0.01;
		}

		const again = await service.getExperience(seed.id as UUID);
		expect(again?.confidence).toBe(0.8);
		expect(again?.tags).toEqual(["t"]);

		await service.stop();
	});

	it("backfills missing tags and keywords when hydrating stored records", async () => {
		const seed = experienceSeed({
			tags: [],
			keywords: [],
			learning: "hydrate missing facets",
		});
		const { runtime } = makeRuntime([seed]);
		const service = await ExperienceService.start(runtime);

		const loaded = await service.getExperience(seed.id as UUID);
		expect(loaded?.tags).toEqual(["general", "learning"]);
		// "general" appears in both the domain and the defaulted tags, so its
		// frequency of 2 outranks the single-appearance learning terms.
		expect(loaded?.keywords).toEqual([
			"general",
			"facets",
			"hydrate",
			"learning",
			"missing",
		]);

		await service.stop();
	});
});

describe("ExperienceService.updateExperience", () => {
	it("returns null when the id does not exist", async () => {
		const { runtime } = makeRuntime([]);
		const service = await ExperienceService.start(runtime);

		await expect(
			service.updateExperience(uniqueId(), { importance: 0.9 }),
		).resolves.toBeNull();

		await service.stop();
	});

	it("keeps the stored embedding and skips the model on metadata-only updates", async () => {
		const seed = experienceSeed({ importance: 0.3 });
		const { runtime, useModel, upsertMemory } = makeRuntime([seed]);
		const service = await ExperienceService.start(runtime);

		const updated = await service.updateExperience(seed.id as UUID, {
			importance: 0.95,
		});

		expect(updated?.importance).toBe(0.95);
		expect(updated?.embedding).toEqual([0.1, 0.2, 0.3]);
		expect(useModel).not.toHaveBeenCalled();
		expect(upsertMemory).toHaveBeenCalledTimes(1);

		const reread = await service.getExperience(seed.id as UUID);
		expect(reread?.importance).toBe(0.95);

		await service.stop();
	});

	it("regenerates embedding and keywords on content updates while pinning identity fields", async () => {
		const seed = experienceSeed({ embedding: [4, 5, 6] });
		const otherId = uniqueId();
		const { runtime, useModel } = makeRuntime([seed]);
		const service = await ExperienceService.start(runtime);

		const updated = await service.updateExperience(seed.id as UUID, {
			id: otherId,
			agentId: otherId,
			createdAt: 123,
			learning: "completely different topic area",
		});

		expect(updated?.id).toBe(seed.id);
		expect(updated?.agentId).toBe(AGENT_ID);
		expect(updated?.createdAt).toBe(BASE_TIME);
		expect(updated?.updatedAt).toBeGreaterThanOrEqual(BASE_TIME);
		// A new vector replaces the seeded one.
		expect(updated?.embedding).toEqual([1, 2, 3]);
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING, {
			text: "ctx act res completely different topic area",
		});
		// Keywords are re-derived from the updated content.
		expect(updated?.keywords).toEqual([
			"area",
			"completely",
			"different",
			"general",
			"topic",
		]);

		await service.stop();
	});
});

describe("ExperienceService.deleteExperience", () => {
	it("removes the record from store and indexes and reports false for repeats", async () => {
		const seed = experienceSeed({ domain: "shell" });
		const { runtime, deleteMemory } = makeRuntime([seed]);
		const service = await ExperienceService.start(runtime);

		await expect(service.deleteExperience(seed.id as UUID)).resolves.toBe(true);
		expect(deleteMemory).toHaveBeenCalledWith(seed.id);
		await expect(service.getExperience(seed.id as UUID)).resolves.toBeNull();
		await expect(service.listExperiences()).resolves.toEqual([]);
		await expect(service.deleteExperience(seed.id as UUID)).resolves.toBe(
			false,
		);

		await service.stop();
	});
});

describe("ExperienceService listing and queries", () => {
	it("returns nothing for an empty store", async () => {
		const { runtime } = makeRuntime([]);
		const service = await ExperienceService.start(runtime);

		await expect(service.listExperiences()).resolves.toEqual([]);

		await service.stop();
	});

	it("sorts by confidence * importance descending and applies the limit", async () => {
		const high = experienceSeed({ confidence: 0.8, importance: 0.9 });
		const mid = experienceSeed({ confidence: 0.6, importance: 0.9 });
		const low = experienceSeed({ confidence: 0.9, importance: 0.1 });
		const { runtime } = makeRuntime([low, high, mid]);
		const service = await ExperienceService.start(runtime);

		const listed = await service.listExperiences();
		expect(listed.map((e) => e.id)).toEqual([high.id, mid.id, low.id]);
		const limited = await service.listExperiences({ limit: 2 });
		expect(limited.map((e) => e.id)).toEqual([high.id, mid.id]);

		await service.stop();
	});

	it("filters by type", async () => {
		const typed = experienceSeed({ type: ExperienceType.SUCCESS });
		const other = experienceSeed({ type: ExperienceType.LEARNING });
		const { runtime } = makeRuntime([other, typed]);
		const service = await ExperienceService.start(runtime);

		const results = await service.queryExperiences({
			type: [ExperienceType.SUCCESS],
		});
		expect(results.map((e) => e.id)).toEqual([typed.id]);

		await service.stop();
	});

	it("filters by outcome, domain, tags, minImportance, and timeRange", async () => {
		const newer = experienceSeed({
			domain: "shell",
			tags: ["urgent"],
			outcome: OutcomeType.POSITIVE,
			confidence: 0.9,
			importance: 0.9,
			createdAt: BASE_TIME,
		});
		const older = experienceSeed({
			domain: "data",
			tags: ["slow"],
			outcome: OutcomeType.NEGATIVE,
			confidence: 0.6,
			importance: 0.2,
			createdAt: BASE_TIME - 10_000,
		});
		const { runtime } = makeRuntime([older, newer]);
		const service = await ExperienceService.start(runtime);
		const ids = (results: { id: UUID }[]) => results.map((e) => e.id);

		const byOutcome = await service.queryExperiences({
			outcome: [OutcomeType.NEGATIVE],
		});
		expect(ids(byOutcome)).toEqual([older.id]);

		const byDomain = await service.queryExperiences({ domain: ["shell"] });
		expect(ids(byDomain)).toEqual([newer.id]);

		const byTags = await service.queryExperiences({
			tags: ["urgent", "slow"],
		});
		expect(ids(byTags)).toEqual([newer.id, older.id]);

		const byImportance = await service.queryExperiences({
			minImportance: 0.85,
		});
		expect(ids(byImportance)).toEqual([newer.id]);

		const sinceStart = await service.queryExperiences({
			timeRange: { start: BASE_TIME - 5_000 },
		});
		expect(ids(sinceStart)).toEqual([newer.id]);

		const untilEnd = await service.queryExperiences({
			timeRange: { end: BASE_TIME - 5_000 },
		});
		expect(ids(untilEnd)).toEqual([older.id]);

		await service.stop();
	});

	it("tracks access counts on queryExperiences but not listExperiences", async () => {
		const seed = experienceSeed({});
		const { runtime } = makeRuntime([seed]);
		const service = await ExperienceService.start(runtime);

		const listed = await service.listExperiences();
		expect(listed[0]?.accessCount).toBe(0);

		const queriedOnce = await service.queryExperiences({});
		expect(queriedOnce[0]?.accessCount).toBe(1);
		expect(typeof queriedOnce[0]?.lastAccessedAt).toBe("number");

		await service.queryExperiences({});
		const reread = await service.getExperience(seed.id as UUID);
		expect(reread?.accessCount).toBe(2);

		await service.stop();
	});

	it("appends referenced-but-unselected experiences when includeRelated is set", async () => {
		// The selected top-ranked record points at a lower-ranked one;
		// includeRelated appends what the selected results reference.
		const referenced = experienceSeed({
			confidence: 0.3,
			importance: 0.3,
		});
		const referencing = experienceSeed({
			confidence: 0.9,
			importance: 0.9,
			relatedExperiences: [referenced.id as UUID],
		});
		const { runtime } = makeRuntime([referencing, referenced]);
		const service = await ExperienceService.start(runtime);

		const plain = await service.listExperiences({ limit: 1 });
		expect(plain.map((e) => e.id)).toEqual([referencing.id]);

		const expanded = await service.listExperiences({
			limit: 1,
			includeRelated: true,
		});
		expect(expanded.map((e) => e.id)).toEqual([referencing.id, referenced.id]);

		await service.stop();
	});
});

describe("ExperienceService.dedupeDuplicateExperiences", () => {
	const SAME_LEARNING = "confirm before deleting production rows always";

	function duplicatePair(): Memory[] {
		return [
			experienceSeed({
				tags: ["alpha"],
				keywords: ["keep-kw"],
				confidence: 0.8,
				importance: 0.9,
				accessCount: 3,
				lastAccessedAt: 5_000,
				learning: SAME_LEARNING,
			}),
			experienceSeed({
				tags: ["beta"],
				keywords: ["lose-kw"],
				confidence: 0.9,
				importance: 0.2,
				accessCount: 2,
				lastAccessedAt: 9_000,
				learning: SAME_LEARNING,
			}),
		];
	}

	it("reports zero activity on an empty store", async () => {
		const { runtime } = makeRuntime([]);
		const service = await ExperienceService.start(runtime);

		await expect(service.dedupeDuplicateExperiences()).resolves.toEqual({
			inspected: 0,
			groups: [],
			merged: 0,
			deleted: 0,
		});

		await service.stop();
	});

	it("leaves distinct learnings ungrouped", async () => {
		const left = experienceSeed({
			learning: "always confirm before deleting production rows",
		});
		const right = experienceSeed({
			learning: "prefer streaming responses for long completions",
		});
		const { runtime } = makeRuntime([left, right]);
		const service = await ExperienceService.start(runtime);

		await expect(service.dedupeDuplicateExperiences()).resolves.toMatchObject({
			inspected: 2,
			groups: [],
			merged: 0,
			deleted: 0,
		});

		await service.stop();
	});

	it("merges into the strongest record and supersedes the weaker one by default", async () => {
		const [keep, lose] = duplicatePair();
		const { runtime } = makeRuntime([keep, lose]);
		const service = await ExperienceService.start(runtime);

		const result = await service.dedupeDuplicateExperiences();

		expect(result.inspected).toBe(2);
		expect(result.merged).toBe(1);
		expect(result.deleted).toBe(0);
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]).toMatchObject({
			primaryId: keep.id,
			duplicateIds: [lose.id],
			reason: "duplicate learning text",
		});
		expect(result.groups[0]?.mergedKeywords).toEqual(["keep-kw", "lose-kw"]);

		const primary = await service.getExperience(keep.id as UUID);
		// Max confidence wins across the pair.
		expect(primary?.confidence).toBe(0.9);
		expect(primary?.importance).toBe(0.9);
		expect(primary?.accessCount).toBe(5);
		expect(primary?.lastAccessedAt).toBe(9_000);
		expect(primary?.tags).toEqual(["alpha", "beta"]);
		expect(primary?.keywords).toEqual(["keep-kw", "lose-kw"]);
		expect(primary?.mergedExperienceIds).toContain(lose.id);
		expect(primary?.relatedExperiences).toContain(lose.id);

		const superseded = await service.getExperience(lose.id as UUID);
		// The survivor is clamped to at most 0.4 confidence and points at its replacement.
		expect(superseded?.confidence).toBe(0.4);
		expect(superseded?.supersedes).toBe(keep.id);
		expect(superseded?.relatedExperiences).toContain(keep.id);

		await service.stop();
	});

	it("deletes the duplicate instead when deleteDuplicates is set", async () => {
		const [keep, lose] = duplicatePair();
		const { runtime, deleteMemory } = makeRuntime([keep, lose]);
		const service = await ExperienceService.start(runtime);

		const result = await service.dedupeDuplicateExperiences({
			deleteDuplicates: true,
		});

		expect(result.deleted).toBe(1);
		expect(result.merged).toBe(1);
		await expect(service.getExperience(lose.id as UUID)).resolves.toBeNull();
		expect(deleteMemory).toHaveBeenCalledWith(lose.id);

		const primary = await service.getExperience(keep.id as UUID);
		expect(primary?.confidence).toBe(0.9);
		expect(primary?.accessCount).toBe(5);
		expect(primary?.mergedExperienceIds).toContain(lose.id);

		await service.stop();
	});
});

describe("ExperienceService.analyzeExperiences", () => {
	it("returns a zeroed analysis for an empty store", async () => {
		const { runtime } = makeRuntime([]);
		const service = await ExperienceService.start(runtime);

		await expect(service.analyzeExperiences()).resolves.toEqual({
			pattern: "No experiences found for analysis",
			frequency: 0,
			reliability: 0,
			alternatives: [],
			recommendations: [],
		});

		await service.stop();
	});

	it("summarizes frequency, common patterns, reliability tier, and recommendations", async () => {
		const first = experienceSeed({
			confidence: 0.8,
			outcome: OutcomeType.POSITIVE,
			domain: "data",
			learning: "retry network requests after failure",
		});
		const second = experienceSeed({
			confidence: 0.6,
			outcome: OutcomeType.POSITIVE,
			domain: "data",
			learning: "retry network requests when timeout occurs",
		});
		const { runtime } = makeRuntime([first, second]);
		const service = await ExperienceService.start(runtime);

		const analysis = await service.analyzeExperiences();

		expect(analysis.frequency).toBe(2);
		// Words appearing in both texts outrank single-text words; ties keep
		// insertion order.
		expect(analysis.pattern).toBe(
			"Common patterns: retry, network, requests, after, failure",
		);
		// reliability = (avgConfidence 0.7 + outcomeConsistency 1) / 2 → top tier.
		expect(analysis.reliability).toBeCloseTo(0.85, 10);
		expect(analysis.recommendations).toEqual([
			"Continue using successful approaches",
			"Document and share these reliable methods",
		]);

		await service.stop();
	});

	it("collects corrected beliefs and 'instead' clauses as alternatives", async () => {
		const correction = experienceSeed({
			type: ExperienceType.CORRECTION,
			correctedBelief: "use exponential backoff",
		});
		const negative = experienceSeed({
			outcome: OutcomeType.NEGATIVE,
			learning: "stream partial results instead of buffering everything",
		});
		const { runtime } = makeRuntime([correction, negative]);
		const service = await ExperienceService.start(runtime);

		const analysis = await service.analyzeExperiences();

		expect(analysis.frequency).toBe(2);
		expect([...(analysis.alternatives ?? [])].sort()).toEqual(
			["of buffering everything", "use exponential backoff"].sort(),
		);

		await service.stop();
	});
});

describe("ExperienceService.stop", () => {
	it("persists every in-memory experience durably on shutdown", async () => {
		const first = experienceSeed({ learning: "shutdown persist one" });
		const second = experienceSeed({ learning: "shutdown persist two" });
		const { runtime, upsertMemory } = makeRuntime([first, second]);
		const service = await ExperienceService.start(runtime);

		await service.stop();

		expect(upsertMemory).toHaveBeenCalledTimes(2);
		const savedIds = upsertMemory.mock.calls.map((call) => {
			const memory = call[0] as Memory;
			return (memory.content.data as { id?: string }).id;
		});
		expect(savedIds).toContain(first.id);
		expect(savedIds).toContain(second.id);
	});
});
