import { describe, expect, it } from "vitest";
import {
	createPromptScorer,
	extractPlannerAction,
	type LlmAdapter,
	type OptimizationExample,
	renderDemonstrations,
	runBootstrapFewshot,
	runInstructionSearch,
	runPromptEvolution,
	scoreAgreement,
	scorePlannerAction,
	withDemonstrations,
} from "../src/optimizers/index.js";

/**
 * Deterministic stub adapter.
 *
 * The adapter recognises three kinds of system prompts and produces
 * predictable outputs:
 *
 *   - "good" baseline: returns the user input verbatim — high agreement when
 *     the dataset's expected output equals the input. This baseline already
 *     scores 1.0, so the optimizer cannot improve and the test asserts the
 *     baseline is preserved (no regression).
 *   - "bad" baseline: returns the literal string "WRONG" — agreement is 0.
 *     When the optimizer sees the rewrite instructions, it returns a "good"
 *     replacement so the optimized score jumps to 1.0.
 *   - rewrite-instruction system: returns a string that matches the dataset's
 *     expected output (the desired optimized prompt for the test).
 */
function createStubAdapter(targetPrompt: string): LlmAdapter {
	return {
		async complete(input) {
			const system = input.system ?? "";
			if (
				system.startsWith("You are a prompt engineer.") &&
				system.includes("Improve the SYSTEM PROMPT")
			) {
				return targetPrompt;
			}
			if (
				system.startsWith("You are a prompt engineer.") &&
				system.includes("Mutate the SYSTEM PROMPT")
			) {
				return targetPrompt;
			}
			if (system === targetPrompt) {
				return input.user;
			}
			if (system === "BAD_PROMPT") {
				return "WRONG";
			}
			return input.user;
		},
	};
}

function makeDataset(): OptimizationExample[] {
	return [
		{ id: "1", input: { user: "alpha bravo" }, expectedOutput: "alpha bravo", reward: 1 },
		{ id: "2", input: { user: "charlie delta" }, expectedOutput: "charlie delta", reward: 1 },
		{ id: "3", input: { user: "echo foxtrot" }, expectedOutput: "echo foxtrot", reward: 0.5 },
		{ id: "4", input: { user: "golf hotel" }, expectedOutput: "golf hotel", reward: 0.5 },
	];
}

describe("scoring", () => {
	it("scoreAgreement returns 1 for identical strings", () => {
		expect(scoreAgreement("alpha bravo", "alpha bravo")).toBe(1);
	});
	it("scoreAgreement returns 0 for disjoint strings", () => {
		expect(scoreAgreement("alpha", "bravo")).toBe(0);
	});
	it("scoreAgreement returns Jaccard for partial overlap", () => {
		// tokens(actual) = {alpha, bravo}; tokens(expected) = {alpha, charlie};
		// intersection = {alpha} = 1; union = 3 → 1/3.
		expect(scoreAgreement("alpha bravo", "alpha charlie")).toBeCloseTo(1 / 3);
	});

	it("createPromptScorer averages per-example agreement", async () => {
		const adapter = createStubAdapter("PERFECT_PROMPT");
		const scorer = createPromptScorer(adapter);
		const dataset = makeDataset();
		const score = await scorer("PERFECT_PROMPT", dataset);
		expect(score).toBe(1);
		const wrongScore = await scorer("BAD_PROMPT", dataset);
		expect(wrongScore).toBe(0);
	});

	it("extractPlannerAction pulls name from nested <name> tag", () => {
		const xml = `<response><actions><action><name>BLOCK_APPS</name></action></actions></response>`;
		expect(extractPlannerAction(xml)).toBe("BLOCK_APPS");
	});

	it("extractPlannerAction pulls name from flat <action>NAME</action>", () => {
		expect(extractPlannerAction("<action>REPLY</action>")).toBe("REPLY");
	});

	it("extractPlannerAction prefers nested over flat when both present", () => {
		const xml =
			"<action>WRAPPER</action>…<action><name>CALENDAR_ACTION</name></action>";
		expect(extractPlannerAction(xml)).toBe("CALENDAR_ACTION");
	});

	it("extractPlannerAction falls back to first uppercase identifier", () => {
		expect(extractPlannerAction("chose BLOCK_APPS as best fit")).toBe(
			"BLOCK_APPS",
		);
	});

	it("extractPlannerAction returns null on empty input", () => {
		expect(extractPlannerAction("")).toBeNull();
	});

	it("scorePlannerAction scores 1 on matching action name", () => {
		const actual = "<action><name>BLOCK_APPS</name></action>";
		const expected = "<action><name>BLOCK_APPS</name></action>";
		expect(scorePlannerAction(actual, expected)).toBe(1);
	});

	it("scorePlannerAction scores 0 on different action names", () => {
		const actual = "<action><name>BLOCK_WEBSITES</name></action>";
		const expected = "<action><name>BLOCK_APPS</name></action>";
		expect(scorePlannerAction(actual, expected)).toBe(0);
	});

	it("scorePlannerAction scores 0 when actual lacks a name", () => {
		expect(
			scorePlannerAction("no action here", "<action><name>REPLY</name></action>"),
		).toBe(0);
	});

	it("createPromptScorer uses custom comparator when provided", async () => {
		const adapter: LlmAdapter = {
			async complete() {
				return "<action><name>REPLY</name></action>";
			},
		};
		const scorer = createPromptScorer(adapter, {
			compare: scorePlannerAction,
		});
		const dataset: OptimizationExample[] = [
			{
				id: "1",
				input: { user: "x" },
				expectedOutput: "<action><name>REPLY</name></action>",
				reward: 1,
			},
			{
				id: "2",
				input: { user: "y" },
				expectedOutput: "<action><name>IGNORE</name></action>",
				reward: 1,
			},
		];
		expect(await scorer("sys", dataset)).toBe(0.5);
	});
});

describe("instruction-search optimizer", () => {
	it("improves a bad baseline up to the target", async () => {
		const target = "PERFECT_PROMPT";
		const adapter = createStubAdapter(target);
		const scorer = createPromptScorer(adapter);
		const result = await runInstructionSearch({
			baselinePrompt: "BAD_PROMPT",
			dataset: makeDataset(),
			scorer,
			llm: adapter,
			options: { variants: 2, rounds: 1 },
		});
		expect(result.baseline).toBe(0);
		expect(result.score).toBe(1);
		expect(result.optimizedPrompt).toBe(target);
		expect(result.lineage[0]?.notes).toBe("baseline");
	});

	it("preserves baseline when no improvement is possible", async () => {
		const target = "PERFECT_PROMPT";
		const adapter = createStubAdapter(target);
		const scorer = createPromptScorer(adapter);
		const result = await runInstructionSearch({
			baselinePrompt: target,
			dataset: makeDataset(),
			scorer,
			llm: adapter,
			options: { variants: 2, rounds: 1 },
		});
		expect(result.baseline).toBe(1);
		expect(result.score).toBe(1);
		// Optimized prompt may be either the baseline or the rewrite — both
		// score 1.0 against the dataset, so the optimizer is allowed to keep
		// either.
		expect(result.score).toBeGreaterThanOrEqual(result.baseline);
	});
});

describe("prompt-evolution optimizer", () => {
	it("improves a bad baseline using mutation", async () => {
		const target = "PERFECT_PROMPT";
		const adapter = createStubAdapter(target);
		const scorer = createPromptScorer(adapter);
		const result = await runPromptEvolution({
			baselinePrompt: "BAD_PROMPT",
			dataset: makeDataset(),
			scorer,
			llm: adapter,
			options: {
				population: 4,
				generations: 2,
				mutationRate: 1,
				rng: () => 0.0,
			},
		});
		expect(result.baseline).toBe(0);
		expect(result.score).toBe(1);
		expect(result.optimizedPrompt).toBe(target);
	});

	it("never regresses below baseline", async () => {
		const target = "PERFECT_PROMPT";
		const adapter = createStubAdapter(target);
		const scorer = createPromptScorer(adapter);
		const result = await runPromptEvolution({
			baselinePrompt: target,
			dataset: makeDataset(),
			scorer,
			llm: adapter,
			options: {
				population: 3,
				generations: 1,
				mutationRate: 0.5,
				rng: () => 0.99,
			},
		});
		expect(result.score).toBeGreaterThanOrEqual(result.baseline);
	});
});

describe("bootstrap-fewshot optimizer", () => {
	it("injects top-K demonstrations and returns them in fewShotExamples", async () => {
		const target = "PERFECT_PROMPT";
		const adapter = createStubAdapter(target);
		const scorer = createPromptScorer(adapter);
		const result = await runBootstrapFewshot({
			baselinePrompt: target,
			dataset: makeDataset(),
			scorer,
			llm: adapter,
			options: { k: 2 },
		});
		expect(result.fewShotExamples).toHaveLength(2);
		// Reward-first ranking: ids "1" and "2" both have reward 1.
		expect(result.fewShotExamples?.map((e) => e.id)).toEqual(["1", "2"]);
		expect(result.optimizedPrompt).toContain("Demonstrations:");
		expect(result.score).toBeGreaterThanOrEqual(result.baseline);
	});

	it("renderDemonstrations produces a stable block", () => {
		const block = renderDemonstrations([
			{ input: { user: "u1" }, expectedOutput: "e1" },
		]);
		expect(block).toContain("Example 1:");
		expect(block).toContain("Input:\nu1");
		expect(block).toContain("Expected:\ne1");
	});

	it("withDemonstrations is a no-op for an empty list", () => {
		expect(withDemonstrations("base", [])).toBe("base");
	});
});
