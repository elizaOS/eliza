/**
 * Unit tests for `ExperienceService.findSimilarExperiences` and its shared
 * recall-embedder wiring: a mocked `embedRecallQuery` verifies that a null embed
 * (timeout/error) fails open to the recency/quality fallback set, and that ranking
 * always routes through the shared embedder rather than a direct useModel call.
 * Uses the in-memory mock runtime — no live model, no real DB.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type { Memory } from "../../../types/memory.ts";
import type { UUID } from "../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { ExperienceType, OutcomeType } from "./types.ts";

// Force the shared recall-query embedder to fail open (error → null) so we can
// assert findSimilarExperiences falls back to the recency/quality sort instead
// of throwing or hanging.
const embedRecallQuery =
	vi.fn<(runtime: IAgentRuntime, text: string) => Promise<number[] | null>>();
vi.mock("../../documents/recall-embed.ts", () => ({
	embedRecallQuery: (runtime: IAgentRuntime, text: string) =>
		embedRecallQuery(runtime, text),
}));

// Imported after the mock is registered.
const { ExperienceService } = await import("./service.ts");

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const EXP_OLD = "00000000-0000-0000-0000-00000000e001" as UUID;
const EXP_NEW = "00000000-0000-0000-0000-00000000e002" as UUID;

function experienceMemory(id: UUID, createdAt: number): Memory {
	return {
		id,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: AGENT_ID,
		createdAt,
		content: {
			text: "",
			type: "experience",
			data: {
				id,
				agentId: AGENT_ID,
				type: ExperienceType.LEARNING,
				outcome: OutcomeType.NEUTRAL,
				context: "ctx",
				action: "act",
				result: "res",
				learning: `learning ${id}`,
				domain: "general",
				tags: ["t"],
				keywords: ["k"],
				confidence: 0.8,
				importance: 0.7,
				createdAt,
				updatedAt: createdAt,
				accessCount: 0,
				embedding: [0.1, 0.2, 0.3],
			},
		},
	} as unknown as Memory;
}

function makeRuntime(): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
} {
	const useModel = vi.fn(async () => [0.1, 0.2, 0.3]);
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		getCurrentRunId: () => "33333333-3333-3333-3333-333333333333",
		getMemories: vi.fn(async () => [
			experienceMemory(EXP_OLD, 1_000),
			experienceMemory(EXP_NEW, 2_000),
		]),
		upsertMemory: vi.fn(async () => true),
		useModel,
	});
	return { runtime, useModel };
}

describe("ExperienceService.findSimilarExperiences — shared recall embed fail-open", () => {
	afterEach(() => {
		embedRecallQuery.mockReset();
	});

	test("a null recall embed (timeout/error) falls open to the recency/quality sort, never calling useModel directly", async () => {
		embedRecallQuery.mockResolvedValue(null);
		const { runtime, useModel } = makeRuntime();

		const service = await ExperienceService.start(runtime);

		const results = await service.findSimilarExperiences("any query", 5);

		// Fail-open returns the fallback set (both loaded experiences), not [].
		expect(results.map((e) => e.id).sort()).toEqual([EXP_OLD, EXP_NEW].sort());
		// The provider must route through the shared embedder, not embed directly.
		expect(embedRecallQuery).toHaveBeenCalledWith(runtime, "any query");
		expect(useModel).not.toHaveBeenCalled();

		await service.stop();
	});

	test("a resolved recall embed is used for vector ranking (shared embedder, not a direct useModel call)", async () => {
		embedRecallQuery.mockResolvedValue([0.1, 0.2, 0.3]);
		const { runtime, useModel } = makeRuntime();

		const service = await ExperienceService.start(runtime);

		const results = await service.findSimilarExperiences("any query", 5);

		expect(embedRecallQuery).toHaveBeenCalledWith(runtime, "any query");
		expect(useModel).not.toHaveBeenCalled();
		expect(results.length).toBeGreaterThan(0);

		await service.stop();
	});
});

describe("ExperienceService.findSimilarExperiences — relevance outranks quality", () => {
	const REL = "00000000-0000-0000-0000-00000000e101" as UUID;
	const IRR = "00000000-0000-0000-0000-00000000e102" as UUID;
	const DAY = 24 * 60 * 60 * 1000;

	// Query vector is [1,0,0], so cosine similarity is just the first component.
	function ranked(id: UUID, first: number, quality: "best" | "worst"): Memory {
		const now = Date.now();
		const best = quality === "best";
		return {
			id,
			entityId: AGENT_ID,
			agentId: AGENT_ID,
			roomId: AGENT_ID,
			createdAt: best ? now : now - 365 * DAY,
			content: {
				text: "",
				type: "experience",
				data: {
					id,
					agentId: AGENT_ID,
					type: ExperienceType.LEARNING,
					outcome: OutcomeType.SUCCESS,
					context: "ctx",
					action: "act",
					result: "res",
					learning: best ? "low-relevance" : "high-relevance",
					domain: "general",
					tags: ["t"],
					keywords: ["k"],
					confidence: best ? 1 : 0,
					importance: best ? 1 : 0,
					createdAt: best ? now : now - 365 * DAY,
					updatedAt: best ? now : now - 365 * DAY,
					accessCount: best ? 50 : 0,
					embedding: [first, Math.sqrt(1 - first * first), 0],
				},
			},
		} as unknown as Memory;
	}

	afterEach(() => {
		vi.clearAllMocks();
	});

	test("a 9x less similar experience does not outrank a relevant one on quality alone", async () => {
		embedRecallQuery.mockResolvedValue([1, 0, 0]);
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getCurrentRunId: () => "33333333-3333-3333-3333-333333333333",
			getMemories: vi.fn(async () => [
				ranked(REL, 0.45, "worst"), // cosine 0.45, worst-possible quality
				ranked(IRR, 0.05, "best"), // cosine 0.05 (at the floor), perfect quality
			]),
			upsertMemory: vi.fn(async () => true),
			useModel: vi.fn(async () => [1, 0, 0]),
		});

		const service = await ExperienceService.start(runtime);
		const results = await service.findSimilarExperiences("query", 5);

		// Additive scoring (similarity*0.7 + quality*0.3) ranked "low-relevance"
		// first: 0.05*0.7 + 1*0.3 = 0.335 beats 0.45*0.7 + 0*0.3 = 0.315.
		expect(results[0]?.learning).toBe("high-relevance");

		await service.stop();
	});

	test("quality still decides between comparably relevant experiences", async () => {
		embedRecallQuery.mockResolvedValue([1, 0, 0]);
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getCurrentRunId: () => "33333333-3333-3333-3333-333333333333",
			getMemories: vi.fn(async () => [
				ranked(REL, 0.5, "worst"), // only 1.11x more similar — inside the window
				ranked(IRR, 0.45, "best"),
			]),
			upsertMemory: vi.fn(async () => true),
			useModel: vi.fn(async () => [1, 0, 0]),
		});

		const service = await ExperienceService.start(runtime);
		const results = await service.findSimilarExperiences("query", 5);

		expect(results[0]?.learning).toBe("low-relevance");

		await service.stop();
	});
});
