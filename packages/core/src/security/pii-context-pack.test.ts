/**
 * Exercises the context-retrieval pass (#14805): context packs are assembled
 * from the existing retrieval seams, confident entity resolutions are
 * clustered into the corpus pseudonym map, the per-chunk assignment slice
 * never leaks the whole map (or any real alias), absent sources are audited
 * rather than silently empty, and a present-but-failing source propagates
 * (fail-closed).
 */

import { describe, expect, test, vi } from "vitest";
import type { MessageSearchHit } from "../types/database.js";
import type { Memory, UUID } from "../types/index.js";
import { ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	assembleContextPack,
	buildScrubRequestDraft,
	entityResolverFromStore,
	type PiiContextFragment,
	type PiiResolvedEntity,
	sourcesFromRuntime,
} from "./pii-context-pack.js";
import { CorpusPseudonymMap } from "./pii-pseudonym-map.js";

const RULESET = "2026.07";
const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function makeMap(): CorpusPseudonymMap {
	return new CorpusPseudonymMap({ salt: "fixed-test-salt" });
}

function johnEntity(confidence = 0.9): PiiResolvedEntity {
	return {
		clusterId: "entity:john",
		kind: "person",
		aliases: ["John Smith", "Johnny", "jsmith"],
		identities: [{ platform: "discord", handle: "jsmith" }],
		confidence,
		evidence: ["exact name match"],
	};
}

describe("assembleContextPack", () => {
	test("confident entity resolution clusters into the map and rides the assignment slice", async () => {
		const map = makeMap();
		const pack = await assembleContextPack(
			{ resolveEntity: async () => [johnEntity(0.9)] },
			{
				chunk: "Lunch with John Smith at noon",
				candidates: [{ surfaceForm: "John Smith", kind: "person" }],
				map,
				rulesetVersion: RULESET,
			},
		);

		const cluster = map.getCluster("entity:john");
		if (!cluster) throw new Error("cluster was not assigned");
		expect(cluster.aliases).toContain("John Smith");
		expect(cluster.aliases).toContain("Johnny");
		expect(cluster.identities).toEqual([
			{ platform: "discord", handle: "jsmith" },
		]);
		expect(pack.assignments).toEqual([
			{
				entityClusterId: "entity:john",
				surrogate: cluster.pseudonym,
				kind: "person",
			},
		]);
		expect(pack.candidateSpans).toEqual(["John Smith"]);
		expect(pack.sourcesQueried).toEqual(["entities"]);
		expect(pack.contextPack).toContain("entity:john");
		expect(pack.contextPack).toContain("already pseudonymized");
	});

	test("low-confidence resolution appears as context but is NOT clustered", async () => {
		const map = makeMap();
		const pack = await assembleContextPack(
			{ resolveEntity: async () => [johnEntity(0.3)] },
			{
				chunk: "Maybe John was there",
				candidates: [{ surfaceForm: "John", kind: "person" }],
				map,
				rulesetVersion: RULESET,
			},
		);
		expect(map.size).toBe(0);
		expect(pack.assignments).toEqual([]);
		expect(pack.resolvedEntities).toHaveLength(1);
		expect(pack.contextPack).toContain("entity:john");
		expect(pack.contextPack).not.toContain("already pseudonymized");
	});

	test("the slice is per-chunk: an unrelated mapped cluster never leaks, and no real alias rides the pack's assignments", async () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:unrelated",
			kind: "person",
			aliases: ["Maria Curie"],
			rulesetVersion: RULESET,
		});
		map.assign({
			clusterId: "entity:john",
			kind: "person",
			aliases: ["John Smith"],
			rulesetVersion: RULESET,
		});

		const pack = await assembleContextPack(
			{},
			{
				chunk: "Lunch with John Smith at noon",
				candidates: [{ surfaceForm: "John Smith", kind: "person" }],
				map,
				rulesetVersion: RULESET,
			},
		);
		expect(pack.assignments.map((a) => a.entityClusterId)).toEqual([
			"entity:john",
		]);
		for (const assignment of pack.assignments) {
			expect(Object.keys(assignment).sort()).toEqual([
				"entityClusterId",
				"kind",
				"surrogate",
			]);
		}
		// The pack text never embeds the alias->pseudonym pair.
		const pseudonym = map.getCluster("entity:john")?.pseudonym;
		if (!pseudonym) throw new Error("pseudonym missing");
		expect(pack.contextPack).not.toContain(pseudonym);
	});

	test("fragments are ranked by measured score and bounded; pack text is capped", async () => {
		const map = makeMap();
		const fragments: PiiContextFragment[] = [
			{ text: "low relevance", origin: "memory", score: 0.1 },
			{ text: "high relevance", origin: "document", score: 0.9 },
			{ text: "mid relevance", origin: "message", score: 0.5 },
		];
		const pack = await assembleContextPack(
			{
				searchDocuments: async () => fragments,
			},
			{
				chunk: "Was Paris there?",
				candidates: [{ surfaceForm: "Paris", kind: "person" }],
				map,
				rulesetVersion: RULESET,
				maxFragments: 2,
			},
		);
		expect(pack.contextPack).toContain("high relevance");
		expect(pack.contextPack).toContain("mid relevance");
		expect(pack.contextPack).not.toContain("low relevance");

		const capped = await assembleContextPack(
			{ searchDocuments: async () => fragments },
			{
				chunk: "Was Paris there?",
				candidates: [{ surfaceForm: "Paris", kind: "person" }],
				map,
				rulesetVersion: RULESET,
				maxChars: 32,
			},
		);
		expect(capped.contextPack.length).toBeLessThanOrEqual(32);
	});

	test("absent sources are audited; empty candidates make zero source calls", async () => {
		const map = makeMap();
		const resolveEntity = vi.fn(async () => [] as PiiResolvedEntity[]);
		const searchDocuments = vi.fn(async () => [] as PiiContextFragment[]);
		const pack = await assembleContextPack(
			{ resolveEntity, searchDocuments },
			{
				chunk: "no candidates here",
				candidates: [
					{ surfaceForm: "", kind: "person" },
					{ surfaceForm: "   ", kind: "person" },
				],
				map,
				rulesetVersion: RULESET,
			},
		);
		expect(pack.candidateSpans).toEqual([]);
		expect(pack.sourcesQueried).toEqual(["entities", "documents"]);
		expect(resolveEntity).not.toHaveBeenCalled();
		expect(searchDocuments).not.toHaveBeenCalled();
		expect(pack.contextPack).toBe("");
		expect(pack.assignments).toEqual([]);
	});

	test("duplicate surface forms are deduped into one candidate span", async () => {
		const map = makeMap();
		const searchDocuments = vi.fn(async () => [] as PiiContextFragment[]);
		const pack = await assembleContextPack(
			{ searchDocuments },
			{
				chunk: "John Smith met John Smith",
				candidates: [
					{ surfaceForm: "John Smith", kind: "person" },
					{ surfaceForm: "John Smith", kind: "person" },
				],
				map,
				rulesetVersion: RULESET,
			},
		);
		expect(pack.candidateSpans).toEqual(["John Smith"]);
		expect(searchDocuments).toHaveBeenCalledTimes(1);
	});

	test("a wired source that throws propagates (fail-closed, rails retry)", async () => {
		const map = makeMap();
		await expect(
			assembleContextPack(
				{
					searchMemories: async () => {
						throw new Error("embedding provider failure");
					},
				},
				{
					chunk: "Lunch with John Smith",
					candidates: [{ surfaceForm: "John Smith", kind: "person" }],
					map,
					rulesetVersion: RULESET,
				},
			),
		).rejects.toThrow("embedding provider failure");
	});
});

describe("entityResolverFromStore (EntityStore.resolve seam)", () => {
	const storeCandidate = {
		entity: {
			entityId: "abc-123",
			type: "organization",
			preferredName: "Initech",
			fullName: "Initech Global LLC",
			identities: [{ platform: "x", handle: "initech" }],
		},
		confidence: 0.9,
		evidence: ["exact name match"],
	};

	test("normalizes EntityStore candidates: cluster id prefix, canonical kind, alias union", async () => {
		const resolve = vi.fn(async () => [storeCandidate]);
		const resolver = entityResolverFromStore({ resolve });
		const resolved = await resolver({
			surfaceForm: "Initech",
			kind: "org",
		});
		expect(resolve).toHaveBeenCalledWith({ name: "Initech" });
		expect(resolved).toEqual([
			{
				clusterId: "entity:abc-123",
				kind: "org",
				aliases: ["Initech", "Initech Global LLC", "initech"],
				identities: [{ platform: "x", handle: "initech" }],
				confidence: 0.9,
				evidence: ["exact name match"],
			},
		]);
	});

	test("a handle candidate resolves by platform identity, not by name", async () => {
		const resolve = vi.fn(async () => [storeCandidate]);
		const resolver = entityResolverFromStore({ resolve });
		await resolver({
			surfaceForm: "@initech",
			kind: "org",
			identity: { platform: "x", handle: "initech" },
		});
		expect(resolve).toHaveBeenCalledWith({
			identity: { platform: "x", handle: "initech" },
		});
	});

	test("caps the number of candidates", async () => {
		const resolve = vi.fn(async () =>
			Array.from({ length: 10 }, (_, i) => ({
				...storeCandidate,
				entity: { ...storeCandidate.entity, entityId: `e${i}`, identities: [] },
			})),
		);
		const resolver = entityResolverFromStore({ resolve }, { maxCandidates: 2 });
		const resolved = await resolver({ surfaceForm: "Initech", kind: "org" });
		expect(resolved).toHaveLength(2);
	});
});

describe("sourcesFromRuntime", () => {
	interface FakeRuntimeConfig {
		embeddingModel?: boolean;
		documentsService?: boolean;
	}

	function makeRuntime(config: FakeRuntimeConfig = {}) {
		const searchMessages = vi.fn(
			async (): Promise<MessageSearchHit[]> => [
				{
					memory: {
						id: "m1" as UUID,
						entityId: AGENT_ID,
						roomId: AGENT_ID,
						content: { text: "found message" },
					} as Memory,
					ftsRank: 3.2,
					trigramSimilarity: 0.7,
				},
			],
		);
		const searchMemories = vi.fn(
			async (): Promise<Memory[]> => [
				{
					id: "mem1" as UUID,
					entityId: AGENT_ID,
					roomId: AGENT_ID,
					content: { text: "found memory" },
					similarity: 0.8,
				} as Memory,
			],
		);
		const searchDocuments = vi.fn(async (message: Memory) => {
			void message;
			return [
				{
					id: "doc1" as UUID,
					content: { text: "found document" },
					similarity: 0.9,
				},
			];
		});
		const useModel = vi.fn(async () => [0.1, 0.2, 0.3]);
		const runtime = {
			agentId: AGENT_ID,
			getModel: (type: string) =>
				config.embeddingModel && type === ModelType.TEXT_EMBEDDING
					? () => Promise.resolve([])
					: undefined,
			useModel,
			searchMemories,
			getService: (name: string) =>
				config.documentsService && name === "documents"
					? { searchDocuments }
					: null,
			adapter: { searchMessages },
		} as unknown as IAgentRuntime;
		return {
			runtime,
			searchMessages,
			searchMemories,
			searchDocuments,
			useModel,
		};
	}

	test("wires only the structurally available sources", () => {
		const bare = sourcesFromRuntime(makeRuntime().runtime);
		expect(bare.searchDocuments).toBeUndefined();
		expect(bare.searchMemories).toBeUndefined();
		expect(bare.searchMessages).toBeUndefined();
		expect(bare.resolveEntity).toBeUndefined();

		const full = sourcesFromRuntime(
			makeRuntime({ embeddingModel: true, documentsService: true }).runtime,
			{ roomIds: [AGENT_ID], resolveEntity: async () => [] },
		);
		expect(full.searchDocuments).toBeTypeOf("function");
		expect(full.searchMemories).toBeTypeOf("function");
		expect(full.searchMessages).toBeTypeOf("function");
		expect(full.resolveEntity).toBeTypeOf("function");
	});

	test("documents source maps StoredDocument hits into scored fragments", async () => {
		const { runtime, searchDocuments } = makeRuntime({
			documentsService: true,
		});
		const sources = sourcesFromRuntime(runtime);
		const fragments = await sources.searchDocuments?.("John Smith");
		expect(searchDocuments).toHaveBeenCalledTimes(1);
		expect(fragments).toEqual([
			{ text: "found document", origin: "document", ref: "doc1", score: 0.9 },
		]);
	});

	test("memories source embeds via TEXT_EMBEDDING then searches (throw propagates)", async () => {
		const { runtime, searchMemories, useModel } = makeRuntime({
			embeddingModel: true,
		});
		const sources = sourcesFromRuntime(runtime);
		const fragments = await sources.searchMemories?.("John Smith");
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING, {
			text: "John Smith",
		});
		expect(searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ tableName: "messages", query: "John Smith" }),
		);
		expect(fragments).toEqual([
			{ text: "found memory", origin: "memory", ref: "mem1", score: 0.8 },
		]);

		useModel.mockRejectedValueOnce(new Error("no embedding for you"));
		await expect(sources.searchMemories?.("x")).rejects.toThrow(
			"no embedding for you",
		);
	});

	test("messages source requires explicit roomIds and uses the measured trigram score", async () => {
		const { runtime, searchMessages } = makeRuntime();
		expect(sourcesFromRuntime(runtime).searchMessages).toBeUndefined();

		const sources = sourcesFromRuntime(runtime, { roomIds: [AGENT_ID] });
		const fragments = await sources.searchMessages?.("wire on Friday");
		expect(searchMessages).toHaveBeenCalledWith(
			expect.objectContaining({ roomIds: [AGENT_ID], query: "wire on Friday" }),
		);
		expect(fragments).toEqual([
			{ text: "found message", origin: "message", ref: "m1", score: 0.7 },
		]);
	});
});

describe("buildScrubRequestDraft", () => {
	test("folds the pack into the landed rails' request payload shape", async () => {
		const map = makeMap();
		map.assign({
			clusterId: "entity:john",
			kind: "person",
			aliases: ["John Smith"],
			rulesetVersion: RULESET,
		});
		const pack = await assembleContextPack(
			{ searchDocuments: async () => [] },
			{
				chunk: "Lunch with John Smith",
				candidates: [{ surfaceForm: "John Smith", kind: "person" }],
				map,
				rulesetVersion: RULESET,
			},
		);
		const draft = buildScrubRequestDraft({
			content: "Lunch with John Smith",
			rulesetVersion: RULESET,
			pack,
			itemRef: "memory:abc",
		});
		expect(draft.content).toBe("Lunch with John Smith");
		expect(draft.rulesetVersion).toBe(RULESET);
		expect(draft.candidateSpans).toEqual(["John Smith"]);
		expect(draft.contextPack).toBe(pack.contextPack);
		expect(draft.pseudonymAssignments).toEqual(pack.assignments);
		expect(draft.itemRef).toBe("memory:abc");
		expect(draft.source).toBe("pii-context-pack");
	});
});
