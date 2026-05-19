/**
 * Per-task wiring tests for `OptimizedPromptService` + the runtime-aware
 * resolver. Each of the five core tasks (should_respond, context_routing,
 * action_planner, response, media_description) has a matrix entry covering:
 *
 *   1. artifact present  → optimized prompt injected
 *   2. artifact absent   → baseline returned unchanged
 *   3. `OPTIMIZED_PROMPT_DISABLE` lists the task → baseline returned
 *
 * The resolver is the single chokepoint every wired call site goes through,
 * so testing it directly per task is sufficient to verify each call site's
 * behavior.
 */

import { describe, expect, test } from "vitest";
import {
	OPTIMIZED_PROMPT_SERVICE,
	OPTIMIZED_PROMPT_TASKS,
	type OptimizedPromptArtifact,
	OptimizedPromptService,
	type OptimizedPromptTask,
	parseDisabledTasksEnv,
} from "./optimized-prompt";
import {
	resolveOptimizedPrompt,
	resolveOptimizedPromptForRuntime,
} from "./optimized-prompt-resolver";

const BASELINE = "BASELINE_PROMPT_FOR_TEST";

function makeArtifact(
	task: OptimizedPromptTask,
	prompt: string,
): OptimizedPromptArtifact {
	return {
		task,
		optimizer: "instruction-search",
		baseline: BASELINE,
		prompt,
		score: 0.95,
		baselineScore: 0.5,
		datasetId: "test",
		datasetSize: 10,
		generatedAt: "2024-01-01T00:00:00.000Z",
		lineage: [{ round: 1, variant: 0, score: 0.95 }],
	};
}

/**
 * Build a service with a pre-populated cache for `task`. Bypasses disk I/O —
 * the service is otherwise the production class and exercises the same
 * `getPrompt`/`isTaskDisabled` paths the runtime hits.
 */
function makeServiceWithArtifact(
	task: OptimizedPromptTask,
	prompt: string,
	disabled?: string,
): OptimizedPromptService {
	const service = new OptimizedPromptService();
	if (disabled !== undefined) {
		service.setDisabledTasksFromEnv(disabled);
	} else {
		// Snapshot from process.env was taken at construction; clear it for the
		// "artifact present" case so leftover env from other tests doesn't bleed
		// in.
		service.setDisabledTasksFromEnv(undefined);
	}
	const setPromptDirect = service as unknown as {
		cache: Partial<
			Record<
				OptimizedPromptTask,
				{ artifact: OptimizedPromptArtifact; loadedAt: number }
			>
		>;
	};
	setPromptDirect.cache[task] = {
		artifact: makeArtifact(task, prompt),
		loadedAt: Date.now(),
	};
	return service;
}

function makeRuntime(service: OptimizedPromptService | null): {
	getService: <T>(name: string) => T | null;
} {
	return {
		getService<T>(name: string): T | null {
			if (name === OPTIMIZED_PROMPT_SERVICE) {
				return service as unknown as T | null;
			}
			return null;
		},
	};
}

describe("parseDisabledTasksEnv", () => {
	test("returns empty set when env var is unset", () => {
		const parsed = parseDisabledTasksEnv(undefined);
		expect(parsed.size).toBe(0);
	});

	test("parses comma-separated task names with whitespace tolerance", () => {
		const parsed = parseDisabledTasksEnv(
			"should_respond, response ,context_routing",
		);
		expect(parsed.has("should_respond")).toBe(true);
		expect(parsed.has("response")).toBe(true);
		expect(parsed.has("context_routing")).toBe(true);
		expect(parsed.has("action_planner")).toBe(false);
	});

	test("silently drops unknown task names", () => {
		const parsed = parseDisabledTasksEnv("response,not_a_real_task,planner");
		expect(parsed.has("response")).toBe(true);
		expect(parsed.size).toBe(1);
	});
});

describe("resolveOptimizedPrompt (pure)", () => {
	test("returns baseline when service is null", () => {
		const out = resolveOptimizedPrompt(null, "should_respond", BASELINE);
		expect(out).toBe(BASELINE);
	});

	test("inlines few-shot demonstrations under a Demonstrations block", () => {
		const service = new OptimizedPromptService();
		service.setDisabledTasksFromEnv(undefined);
		const direct = service as unknown as {
			cache: Partial<
				Record<
					OptimizedPromptTask,
					{ artifact: OptimizedPromptArtifact; loadedAt: number }
				>
			>;
		};
		direct.cache.action_planner = {
			artifact: {
				...makeArtifact("action_planner", "OPTIMIZED_BODY"),
				fewShotExamples: [
					{
						input: { user: "hello" },
						expectedOutput: "world",
					},
				],
			},
			loadedAt: Date.now(),
		};
		const out = resolveOptimizedPrompt(service, "action_planner", BASELINE);
		expect(out).toContain("OPTIMIZED_BODY");
		expect(out).toContain("Demonstrations:");
		expect(out).toContain("Example 1:");
		expect(out).toContain("hello");
		expect(out).toContain("world");
	});
});

describe("resolveOptimizedPromptForRuntime — per-task wiring", () => {
	// Each row covers a single task. Using a table keeps the test body free of
	// any `if (task === 'X')` branching, matching the AGENTS.md constraint
	// that the wiring itself must be uniform across tasks.
	const TASK_CASES: ReadonlyArray<{
		task: OptimizedPromptTask;
		optimizedPrompt: string;
	}> = [
		{ task: "should_respond", optimizedPrompt: "OPT_SHOULD_RESPOND" },
		{ task: "context_routing", optimizedPrompt: "OPT_CONTEXT_ROUTING" },
		{ task: "action_planner", optimizedPrompt: "OPT_ACTION_PLANNER" },
		{ task: "response", optimizedPrompt: "OPT_RESPONSE" },
		{ task: "media_description", optimizedPrompt: "OPT_MEDIA_DESCRIPTION" },
		{
			task: "action_descriptions",
			optimizedPrompt: "OPT_ACTION_DESCRIPTIONS",
		},
	];

	test("covers every OPTIMIZED_PROMPT_TASKS entry", () => {
		// Guardrail: if a new task is added to the union, this matrix must be
		// extended so the wiring rule is enforced for the new task too.
		expect(TASK_CASES.map((c) => c.task).sort()).toEqual(
			[...OPTIMIZED_PROMPT_TASKS].sort(),
		);
	});

	for (const { task, optimizedPrompt } of TASK_CASES) {
		describe(`task=${task}`, () => {
			test("artifact present → optimized prompt is injected", () => {
				const service = makeServiceWithArtifact(task, optimizedPrompt);
				const out = resolveOptimizedPromptForRuntime(
					makeRuntime(service),
					task,
					BASELINE,
				);
				expect(out).toBe(optimizedPrompt);
			});

			test("artifact absent → baseline is returned unchanged", () => {
				const service = new OptimizedPromptService();
				service.setDisabledTasksFromEnv(undefined);
				const out = resolveOptimizedPromptForRuntime(
					makeRuntime(service),
					task,
					BASELINE,
				);
				expect(out).toBe(BASELINE);
			});

			test("OPTIMIZED_PROMPT_DISABLE lists task → baseline is returned even with artifact", () => {
				const service = makeServiceWithArtifact(task, optimizedPrompt, task);
				expect(service.isTaskDisabled(task)).toBe(true);
				const out = resolveOptimizedPromptForRuntime(
					makeRuntime(service),
					task,
					BASELINE,
				);
				expect(out).toBe(BASELINE);
			});

			test("OPTIMIZED_PROMPT_DISABLE listing a different task does NOT affect this task", () => {
				// Pick any other task than the one under test so we verify the
				// disable list is per-task, not global.
				const otherTask: OptimizedPromptTask =
					task === "action_planner" ? "response" : "action_planner";
				const service = makeServiceWithArtifact(
					task,
					optimizedPrompt,
					otherTask,
				);
				const out = resolveOptimizedPromptForRuntime(
					makeRuntime(service),
					task,
					BASELINE,
				);
				expect(out).toBe(optimizedPrompt);
			});
		});
	}

	test("missing OptimizedPromptService on runtime → baseline", () => {
		const out = resolveOptimizedPromptForRuntime(
			makeRuntime(null),
			"response",
			BASELINE,
		);
		expect(out).toBe(BASELINE);
	});

	test("runtime without getService → baseline", () => {
		const out = resolveOptimizedPromptForRuntime({}, "response", BASELINE);
		expect(out).toBe(BASELINE);
	});
});
