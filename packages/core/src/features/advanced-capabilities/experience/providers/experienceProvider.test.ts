/**
 * Deterministic unit coverage for the experience context provider. The suite
 * drives the real provider with an in-memory EXPERIENCE service boundary and
 * verifies its retrieval contract, merge semantics, rendering, and fail-soft
 * behavior without invoking a model or database.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../../../types/memory.ts";
import type { UUID } from "../../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { ExperienceService } from "../service.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";
import { experienceProvider } from "./experienceProvider.ts";

const EMPTY_RESULT = { text: "", data: {}, values: {} };

function makeExperience(id: string, learning = `learning-${id}`): Experience {
	return {
		id: id as UUID,
		agentId: "agent-id" as UUID,
		type: ExperienceType.LEARNING,
		outcome: OutcomeType.POSITIVE,
		context: `context-${id}`,
		action: `action-${id}`,
		result: `result-${id}`,
		learning,
		tags: [`tag-${id}`],
		domain: "testing",
		keywords: [`keyword-${id}`],
		associatedEntityIds: [],
		confidence: 0.8,
		importance: 0.9,
		createdAt: 1,
		updatedAt: 1,
		accessCount: 0,
	};
}

function makeMessage(text?: string): Memory {
	return {
		roomId: "room-id" as UUID,
		content: text === undefined ? {} : { text },
	} as Memory;
}

function makeRuntime(options?: {
	semantic?: Experience[];
	top?: Experience[];
	queryError?: unknown;
	listError?: unknown;
}) {
	const queryCalls: unknown[] = [];
	const listCalls: unknown[] = [];
	const reportedErrors: Array<{
		scope: string;
		error: unknown;
		context: unknown;
	}> = [];
	const service = {
		queryExperiences: async (query: unknown) => {
			queryCalls.push(query);
			if (options?.queryError !== undefined) throw options.queryError;
			return options?.semantic ?? [];
		},
		listExperiences: async (query: unknown) => {
			listCalls.push(query);
			if (options?.listError !== undefined) throw options.listError;
			return options?.top ?? [];
		},
	} as unknown as ExperienceService;
	const runtime = {
		getService: (name: string) => (name === "EXPERIENCE" ? service : null),
		reportError: (scope: string, error: unknown, context: unknown) => {
			reportedErrors.push({ scope, error, context });
		},
	} as unknown as IAgentRuntime;

	return { runtime, queryCalls, listCalls, reportedErrors };
}

describe("experienceProvider", () => {
	it("exposes the provider scheduling and authorization contract", () => {
		expect(experienceProvider).toMatchObject({
			name: "experienceProvider",
			dynamic: true,
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
	});

	it("returns empty output when the EXPERIENCE service is unavailable", async () => {
		const runtime = {
			getService: () => null,
			reportError: () => {
				throw new Error("reportError should not be called");
			},
		} as unknown as IAgentRuntime;

		await expect(
			experienceProvider.get(runtime, makeMessage("a long enough message")),
		).resolves.toEqual(EMPTY_RESULT);
	});

	it.each([undefined, "", "123456789"])(
		"skips retrieval for absent or short message text (%s)",
		async (text) => {
			const { runtime, queryCalls, listCalls } = makeRuntime();

			await expect(
				experienceProvider.get(runtime, makeMessage(text)),
			).resolves.toEqual(EMPTY_RESULT);
			expect(queryCalls).toEqual([]);
			expect(listCalls).toEqual([]);
		},
	);

	it("returns empty output when both retrieval sources are empty", async () => {
		const { runtime, queryCalls, listCalls } = makeRuntime();

		await expect(
			experienceProvider.get(runtime, makeMessage("find prior learnings")),
		).resolves.toEqual(EMPTY_RESULT);
		expect(queryCalls).toEqual([
			{
				query: "find prior learnings",
				limit: 5,
				minConfidence: 0.6,
				minImportance: 0.5,
				includeRelated: true,
			},
		]);
		expect(listCalls).toEqual([
			{ limit: 3, minConfidence: 0.7, minImportance: 0.7 },
		]);
	});

	it("preserves source order, keeps the later duplicate value, and renders every unique result", async () => {
		const semanticFirst = makeExperience("shared", "semantic version wins");
		const semanticSecond = makeExperience("semantic-second");
		const topDuplicate = makeExperience("shared", "top version loses");
		const topOnly = makeExperience("top-only");
		const { runtime } = makeRuntime({
			semantic: [semanticFirst, semanticSecond],
			top: [topDuplicate, topOnly],
		});

		const result = await experienceProvider.get(
			runtime,
			makeMessage("use what worked previously"),
		);

		expect(result.data).toEqual({
			experiences: [topDuplicate, semanticSecond, topOnly],
			count: 3,
		});
		expect(result.values).toEqual({ experienceCount: "3" });
		expect(result.text).toContain("[RELEVANT EXPERIENCES]");
		expect(result.text).toContain("1. DO: top version loses");
		expect(result.text).toContain("2. DO: learning-semantic-second");
		expect(result.text).toContain("3. DO: learning-top-only");
		expect(result.text).not.toContain("semantic version wins");
		expect(result.text).toMatch(/\[\/RELEVANT EXPERIENCES\]$/);
	});

	it.each([
		[
			"semantic query",
			{ queryError: new Error("query unavailable") },
			"query unavailable",
		],
		["top list", { listError: "list unavailable" }, "list unavailable"],
	] as const)(
		"reports a %s failure and returns an explicit unavailable result",
		async (_source, options, expectedError) => {
			const { runtime, reportedErrors } = makeRuntime(options);
			const result = await experienceProvider.get(
				runtime,
				makeMessage("retrieve relevant experience"),
			);

			expect(result).toEqual({
				text: "Relevant experiences are unavailable.",
				data: { available: false, error: expectedError },
				values: { experienceContextAvailable: false },
			});
			expect(reportedErrors).toHaveLength(1);
			expect(reportedErrors[0]).toMatchObject({
				scope: "ExperienceProvider.get",
				context: { roomId: "room-id" },
			});
		},
	);
});
