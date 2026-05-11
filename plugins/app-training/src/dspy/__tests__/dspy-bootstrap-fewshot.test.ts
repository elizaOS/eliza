/**
 * DSPy BootstrapFewshot: synthesize 10 examples with distinct rewards, run
 * the optimizer with k=3, and assert the top-3 by reward are selected.
 */

import { describe, expect, it } from "vitest";
import type { Example } from "../examples.js";
import { MockAdapter } from "../lm-adapter.js";
import { runDspyBootstrapFewshot } from "../optimizers/dspy-bootstrap-fewshot.js";
import type { Metric } from "../optimizers/types.js";
import { defineSignature } from "../signature.js";

describe("runDspyBootstrapFewshot", () => {
	it("selects the top-k examples by reward", async () => {
		const signature = defineSignature<{ input: string }, { output: string }>({
			name: "synth",
			instructions: "Echo the input.",
			inputs: [{ name: "input", description: "input", type: "string" }],
			outputs: [{ name: "output", description: "output", type: "string" }],
		});

		// 10 synthetic examples with rewards 0.1, 0.2, ..., 1.0. The three
		// highest-reward rows should land in the demonstrations.
		const dataset: Example[] = Array.from({ length: 10 }, (_, i) => ({
			inputs: { input: `q${i}` },
			outputs: { output: `a${i}` },
			reward: (i + 1) / 10,
		}));

		const lm = new MockAdapter({ defaultResponse: "output: not-the-answer" });
		const metric: Metric = (predicted, expected) =>
			predicted.output === expected.output ? 1 : 0;

		const result = await runDspyBootstrapFewshot(
			{ signature, dataset, lm, metric },
			{ k: 3 },
		);

		expect(result.optimizer).toBe("dspy-bootstrap-fewshot");
		expect(result.demonstrations).toHaveLength(3);
		const sources = result.demonstrations.map((d) => d.inputs.input);
		// rewards 1.0, 0.9, 0.8 correspond to inputs q9, q8, q7.
		expect(sources).toEqual(["q9", "q8", "q7"]);
		expect(result.lineage[0]?.notes).toBe("baseline");
		expect(result.lineage[1]?.notes).toContain("injected 3");
	});
});
