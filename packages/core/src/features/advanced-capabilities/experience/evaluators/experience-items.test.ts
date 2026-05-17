import { describe, expect, it, vi } from "vitest";
import type { EvaluatorProcessorContext } from "../../../../types/evaluator";
import type { Memory } from "../../../../types/memory";
import type { UUID } from "../../../../types/primitives";
import type { IAgentRuntime } from "../../../../types/runtime";
import type { State } from "../../../../types/state";
import type { ExperienceService } from "../service";
import { type Experience, ExperienceType, OutcomeType } from "../types";
import { experiencePatternEvaluator } from "./experience-items";

type ExperienceRuntime = IAgentRuntime & {
	getService: ReturnType<typeof vi.fn>;
	getSetting: ReturnType<typeof vi.fn>;
	getCache: ReturnType<typeof vi.fn>;
	setCache: ReturnType<typeof vi.fn>;
	getMemories: ReturnType<typeof vi.fn>;
	redactSecrets: ReturnType<typeof vi.fn>;
};

function makeMemory(text: string, overrides: Partial<Memory> = {}): Memory {
	return {
		id: `00000000-0000-0000-0000-${Math.random().toString().slice(2, 14).padEnd(12, "0")}` as UUID,
		entityId: "00000000-0000-0000-0000-000000000001" as UUID,
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text },
		createdAt: 1,
		...overrides,
	};
}

function makeState(actionResults: unknown[] = []): State {
	return {
		values: {},
		data: { actionResults },
		text: "",
	};
}

function makeExperience(overrides: Partial<Experience> = {}): Experience {
	return {
		id: "00000000-0000-0000-0000-00000000e001" as UUID,
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		type: ExperienceType.LEARNING,
		outcome: OutcomeType.NEUTRAL,
		context: "existing context",
		action: "existing action",
		result: "existing result",
		learning: "Use npm install",
		tags: ["existing"],
		domain: "package-management",
		keywords: ["npm", "install"],
		associatedEntityIds: [],
		confidence: 0.8,
		importance: 0.7,
		createdAt: 1,
		updatedAt: 1,
		accessCount: 0,
		...overrides,
	};
}

function makeRuntime(
	args: {
		recentMessages?: Memory[];
		existingExperiences?: Experience[];
		settings?: Record<string, string | number>;
	} = {},
): ExperienceRuntime {
	const cache = new Map<string, string>();
	const service = {
		findSimilarExperiences: vi.fn(async () => args.existingExperiences ?? []),
		recordExperience: vi.fn(async () => makeExperience()),
	};
	return {
		agentId: "00000000-0000-0000-0000-000000000002" as UUID,
		character: { name: "Eliza", bio: "", system: "" },
		getService: vi.fn(() => service),
		getSetting: vi.fn((key: string) => args.settings?.[key]),
		getCache: vi.fn(async (key: string) => cache.get(key)),
		setCache: vi.fn(async (key: string, value: string) => {
			cache.set(key, value);
		}),
		getMemories: vi.fn(async () => args.recentMessages ?? []),
		redactSecrets: vi.fn((text: string) =>
			text.replace(/\bcsk-[A-Za-z0-9_-]+/g, "[REDACTED]"),
		),
		__experienceService: service,
	} as unknown as ExperienceRuntime;
}

function getExperienceService(runtime: ExperienceRuntime) {
	return (runtime as unknown as { __experienceService: ExperienceService })
		.__experienceService;
}

describe("experiencePatternEvaluator", () => {
	it("does not run on ordinary chat before the fallback interval", async () => {
		const runtime = makeRuntime();
		const shouldRun = await experiencePatternEvaluator.shouldRun({
			runtime,
			message: makeMemory("hello, how are you?"),
			state: makeState(),
			options: {},
		});

		expect(shouldRun).toBe(false);
		expect(runtime.getMemories).not.toHaveBeenCalled();
	});

	it("runs immediately when the turn contains an explicit reusable lesson", async () => {
		const runtime = makeRuntime();
		const shouldRun = await experiencePatternEvaluator.shouldRun({
			runtime,
			message: makeMemory(
				"Remember this lesson: next time run the package-specific test before the full suite.",
			),
			state: makeState(),
			options: {},
		});

		expect(shouldRun).toBe(true);
		expect(runtime.setCache).toHaveBeenCalledWith(
			"experience-extraction:00000000-0000-0000-0000-000000000003:last-run-count",
			"1",
		);
	});

	it("uses the fallback interval only when the recent window has an experience signal", async () => {
		const runtime = makeRuntime({
			recentMessages: [
				makeMemory("ordinary turn"),
				makeMemory("Root cause was the parser accepted the wrong JSON block."),
			],
		});
		await runtime.setCache(
			"experience-extraction:00000000-0000-0000-0000-000000000003:message-count",
			"24",
		);

		const shouldRun = await experiencePatternEvaluator.shouldRun({
			runtime,
			message: makeMemory("ok"),
			state: makeState(),
			options: {},
		});

		expect(shouldRun).toBe(true);
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ tableName: "messages", limit: 12 }),
		);
	});

	it("filters synthetic summaries and redacts secrets while preparing context", async () => {
		const runtime = makeRuntime({
			recentMessages: [
				makeMemory("validated fix with csk-abc1234567890"),
				makeMemory("[conversation summary] user likes squash", {
					metadata: { source: "conversation-compaction", tags: ["compaction"] },
				}),
			],
		});
		const prepared = await experiencePatternEvaluator.prepare?.({
			runtime,
			message: makeMemory("validated fix"),
			state: makeState(),
			options: {},
		});

		expect(prepared?.conversationContext).toContain("[REDACTED]");
		expect(prepared?.conversationContext).not.toContain("csk-abc1234567890");
		expect(prepared?.conversationContext).not.toContain("conversation summary");
		expect(
			getExperienceService(runtime).findSimilarExperiences,
		).toHaveBeenCalledWith(expect.stringContaining("[REDACTED]"), 5);
	});

	it("deduplicates normalized existing and same-batch learning before recording", async () => {
		const runtime = makeRuntime({
			existingExperiences: [makeExperience({ learning: "Use npm install" })],
		});
		const prepared = {
			experienceService: getExperienceService(runtime),
			recentMessages: [makeMemory("remember this lesson")],
			conversationContext: "remember this lesson",
			signalSummary: "explicit learning request",
			existingExperiences: [makeExperience({ learning: "Use npm install" })],
			provenance: {
				sourceMessageIds: [],
				sourceRoomId: "00000000-0000-0000-0000-000000000003" as UUID,
				associatedEntityIds: [],
			},
		};
		const processor = experiencePatternEvaluator.processors?.[0];

		const result = await processor?.process({
			runtime,
			message: makeMemory("remember this lesson"),
			state: makeState(),
			options: {},
			evaluatorName: experiencePatternEvaluator.name,
			prepared,
			output: {
				experiences: [
					{
						type: ExperienceType.LEARNING,
						outcome: OutcomeType.NEUTRAL,
						domain: "package-management",
						learning: "Use npm install!",
						context: "existing duplicate",
						confidence: 0.9,
						importance: 0.8,
						reasoning: "duplicate",
					},
					{
						type: ExperienceType.LEARNING,
						outcome: OutcomeType.POSITIVE,
						domain: "package-management",
						learning: "Use bun install instead.",
						context: "new lesson",
						confidence: 0.9,
						importance: 0.8,
						reasoning: "new",
					},
					{
						type: ExperienceType.LEARNING,
						outcome: OutcomeType.POSITIVE,
						domain: "package-management",
						learning: "Use bun install instead",
						context: "same batch duplicate",
						confidence: 0.9,
						importance: 0.8,
						reasoning: "duplicate",
					},
				],
			},
		} as EvaluatorProcessorContext);

		expect(result?.data).toEqual(
			expect.objectContaining({
				extractedCount: 3,
				recordedCount: 1,
				skippedDuplicateCount: 2,
			}),
		);
		expect(
			getExperienceService(runtime).recordExperience,
		).toHaveBeenCalledTimes(1);
	});
});
