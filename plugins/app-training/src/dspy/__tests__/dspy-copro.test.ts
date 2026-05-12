/**
 * DSPy COPRO: 2-iteration run with a MockAdapter that returns successive
 * "improved" instruction proposals. Assert the final instructions differ from
 * baseline AND that the best proposal beats baseline on the synthetic dataset.
 */

import { describe, expect, it } from "vitest";
import type { Example } from "../examples.js";
import {
	type GenerateArgs,
	type GenerateResult,
	type LanguageModelAdapter,
	MockAdapter,
} from "../lm-adapter.js";
import { runDspyCopro } from "../optimizers/dspy-copro.js";
import type { Metric } from "../optimizers/types.js";
import { defineSignature } from "../signature.js";

describe("runDspyCopro", () => {
	it("rewrites the instructions when a proposal scores higher than baseline", async () => {
		const signature = defineSignature<{ input: string }, { output: string }>({
			name: "synth",
			instructions: "BASELINE_INSTRUCTIONS",
			inputs: [{ name: "input", description: "input", type: "string" }],
			outputs: [{ name: "output", description: "output", type: "string" }],
		});
		const dataset: Example[] = [
			{ inputs: { input: "hi" }, outputs: { output: "OK" } },
			{ inputs: { input: "yo" }, outputs: { output: "OK" } },
		];

		// Teacher LM emits a fresh, distinct instruction proposal each call.
		let teacherCall = 0;
		const teacher: LanguageModelAdapter = {
			name: "teacher",
			async generate(_args: GenerateArgs): Promise<GenerateResult> {
				teacherCall += 1;
				return {
					text: `IMPROVED_INSTRUCTIONS_${teacherCall}`,
					usage: {},
				};
			},
		};

		// Student LM: only the improved instructions block produces "OK".
		// Baseline always produces "WRONG", so the optimizer should prefer the
		// rewritten instructions.
		const student: LanguageModelAdapter = {
			name: "student",
			async generate(args: GenerateArgs): Promise<GenerateResult> {
				if (args.system.includes("IMPROVED_INSTRUCTIONS")) {
					return { text: "output: OK", usage: {} };
				}
				return { text: "output: WRONG", usage: {} };
			},
		};

		const metric: Metric = (predicted, expected) =>
			predicted.output === expected.output ? 1 : 0;

		const result = await runDspyCopro(
			{ signature, dataset, lm: student, metric, teacher },
			{ depth: 2, variants: 1 },
		);

		expect(result.optimizer).toBe("dspy-copro");
		expect(result.instructions).not.toBe("BASELINE_INSTRUCTIONS");
		expect(result.instructions).toContain("IMPROVED_INSTRUCTIONS");
		expect(result.score).toBeGreaterThan(result.baselineScore);
		expect(result.baselineScore).toBe(0);
		// Lineage: baseline + at least one variant per round.
		expect(result.lineage.length).toBeGreaterThanOrEqual(3);
		// Suppress unused-binding lint for the MockAdapter import (kept for
		// symmetry with the other DSPy tests; future tests in this file may
		// swap teacher → MockAdapter once they require canned proposals).
		void MockAdapter;
	});
});
