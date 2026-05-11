/**
 * DSPy MIPROv2: 2-iteration synthetic run. Assert the emitted artifact has
 * `optimizer: "dspy-mipro"` and that it roundtrips through the
 * `eliza_native_v1`-compatible artifact reader in `@elizaos/core`.
 */

import { describe, expect, it } from "vitest";
import { parseOptimizedPromptArtifact } from "@elizaos/core";
import { buildDspyArtifact } from "../artifact.js";
import type { Example } from "../examples.js";
import { MockAdapter } from "../lm-adapter.js";
import { runDspyMipro } from "../optimizers/dspy-mipro.js";
import type { Metric } from "../optimizers/types.js";
import { defineSignature } from "../signature.js";

describe("runDspyMipro", () => {
	it("emits an artifact tagged dspy-mipro that the core reader accepts", async () => {
		const signature = defineSignature<{ input: string }, { output: string }>({
			name: "synth",
			instructions: "BASELINE",
			inputs: [{ name: "input", description: "i", type: "string" }],
			outputs: [{ name: "output", description: "o", type: "string" }],
		});
		const dataset: Example[] = [
			{
				inputs: { input: "q1" },
				outputs: { output: "OK" },
				reward: 1,
			},
			{
				inputs: { input: "q2" },
				outputs: { output: "OK" },
				reward: 0.5,
			},
		];

		// Teacher: always returns the same improved-instructions string.
		const teacher = new MockAdapter({
			defaultResponse: "IMPROVED",
		});
		// Student: always emits "output: OK" so every candidate scores 1.0.
		const student = new MockAdapter({
			defaultResponse: "output: OK",
		});

		const metric: Metric = (predicted, expected) =>
			predicted.output === expected.output ? 1 : 0;

		const result = await runDspyMipro(
			{ signature, dataset, lm: student, metric, teacher },
			{
				k: 1,
				instructionVariants: 2,
				demoSets: 2,
				evalBudget: 4,
				rng: makeSeededRng(7),
			},
		);

		expect(result.optimizer).toBe("dspy-mipro");
		expect(result.score).toBeGreaterThanOrEqual(result.baselineScore);

		// Build the eliza_native_v1-compatible artifact and pass it through
		// the parser to confirm round-trip.
		const artifact = buildDspyArtifact({
			task: "action_planner",
			baseline: "BASELINE",
			datasetId: "synthetic://mipro",
			datasetSize: dataset.length,
			result,
		});
		expect(artifact.optimizer).toBe("dspy-mipro");
		const parsed = parseOptimizedPromptArtifact({
			task: artifact.task,
			optimizer: artifact.optimizer,
			baseline: artifact.baseline,
			prompt: artifact.prompt,
			score: artifact.score,
			baselineScore: artifact.baselineScore,
			datasetId: artifact.datasetId,
			datasetSize: artifact.datasetSize,
			generatedAt: artifact.generatedAt,
			lineage: artifact.lineage,
			fewShotExamples: artifact.fewShotExamples,
		});
		expect(parsed).not.toBeNull();
		expect(parsed?.optimizer).toBe("dspy-mipro");
		expect(parsed?.task).toBe("action_planner");
	});
});

/** Linear-congruential RNG for deterministic test runs. */
function makeSeededRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}
