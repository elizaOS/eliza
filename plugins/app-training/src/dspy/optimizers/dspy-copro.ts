/**
 * DSPy-style COPRO (Coordinate ascent over Prompt instructions) optimizer.
 *
 * Loop:
 *   for round in 1..depth:
 *     1. Propose N instruction variants via the teacher LM.
 *     2. Score each variant on a held-out subset of the dataset.
 *     3. Keep the highest-scoring variant as the new baseline for the next
 *        round (greedy coordinate ascent).
 *
 * Returns the best (instructions, demonstrations=[]) pair observed. The
 * caller can then re-train demonstrations on top of the winning instructions
 * via BootstrapFewshot, which is what MIPRO does internally.
 */

import { Predict } from "../predict.js";
import type { Example } from "../examples.js";
import type { LanguageModelAdapter } from "../lm-adapter.js";
import { Signature } from "../signature.js";
import type {
	DspyOptimizerInput,
	DspyOptimizerResult,
	Metric,
	OptimizerLineageEntry,
} from "./types.js";

export interface DspyCoproOptions {
	/** Variants to propose per round. Defaults to 6. */
	variants?: number;
	/** Rounds of coordinate ascent. Defaults to 3. */
	depth?: number;
	/** Eval-set size per variant. Defaults to all examples. */
	evalSubset?: number;
	/** Teacher temperature for instruction proposal. Defaults to 0.8. */
	teacherTemperature?: number;
	/** Deterministic RNG for evalSubset sampling. Defaults to Math.random. */
	rng?: () => number;
}

const PROPOSAL_SYSTEM = `You are rewriting the INSTRUCTIONS field of a task-prompt signature. The signature declares input fields, output fields, and a natural-language INSTRUCTIONS body. Your job is to produce a new INSTRUCTIONS body that makes a downstream language model perform the task more reliably.

Hard constraints:
- Preserve the semantic contract — the new instructions must still describe the same task and reference the same output fields.
- Keep the rewrite concise (no preamble, no markdown headers, no role-play framing).
- Output ONLY the rewritten instructions body — no fences, no commentary.`;

export async function runDspyCopro(
	input: DspyOptimizerInput,
	options: DspyCoproOptions = {},
): Promise<DspyOptimizerResult> {
	const variants = Math.max(1, options.variants ?? 6);
	const depth = Math.max(1, options.depth ?? 3);
	const teacher = input.teacher ?? input.lm;
	const teacherTemperature = options.teacherTemperature ?? 0.8;
	const rng = options.rng ?? Math.random;
	const lineage: OptimizerLineageEntry[] = [];

	const heldOut =
		typeof options.evalSubset === "number"
			? subsample(input.dataset, options.evalSubset, rng)
			: input.dataset;

	const baselineInstructions = input.signature.spec.instructions;
	const baselineScore = await scoreInstructions(
		baselineInstructions,
		input.signature,
		heldOut,
		input.lm,
		input.metric,
	);
	lineage.push({
		round: 0,
		variant: 0,
		score: baselineScore,
		notes: "baseline",
	});

	let bestInstructions = baselineInstructions;
	let bestScore = baselineScore;
	let currentInstructions = baselineInstructions;

	for (let round = 1; round <= depth; round += 1) {
		let roundBestInstructions = currentInstructions;
		let roundBestScore = bestScore;
		for (let variant = 1; variant <= variants; variant += 1) {
			const candidate = await proposeInstructions(
				teacher,
				input.signature,
				currentInstructions,
				teacherTemperature,
			);
			if (candidate.trim().length === 0) {
				lineage.push({
					round,
					variant,
					score: 0,
					notes: "empty proposal — skipped",
				});
				continue;
			}
			const score = await scoreInstructions(
				candidate,
				input.signature,
				heldOut,
				input.lm,
				input.metric,
			);
			lineage.push({ round, variant, score });
			if (score > roundBestScore) {
				roundBestScore = score;
				roundBestInstructions = candidate;
			}
		}
		if (roundBestScore > bestScore) {
			bestScore = roundBestScore;
			bestInstructions = roundBestInstructions;
		}
		currentInstructions = roundBestInstructions;
	}

	return {
		optimizer: "dspy-copro",
		signature: new Signature({
			...input.signature.spec,
			instructions: bestInstructions,
		}),
		instructions: bestInstructions,
		demonstrations: [],
		score: bestScore,
		baselineScore,
		lineage,
	};
}

async function proposeInstructions(
	teacher: LanguageModelAdapter,
	signature: import("../signature.js").Signature,
	current: string,
	temperature: number,
): Promise<string> {
	const ioSummary = [
		`signature name: ${signature.spec.name}`,
		"input fields:",
		...signature.spec.inputs.map(
			(f) => `- ${f.name} (${f.type}): ${f.description}`,
		),
		"output fields:",
		...signature.spec.outputs.map(
			(f) => `- ${f.name} (${f.type}): ${f.description}`,
		),
		"",
		"Current INSTRUCTIONS body:",
		current,
	].join("\n");
	const result = await teacher.generate({
		system: PROPOSAL_SYSTEM,
		messages: [{ role: "user", content: ioSummary }],
		temperature,
		maxTokens: 1024,
	});
	return result.text
		.trim()
		.replace(/^```[a-z0-9_-]*\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
}

async function scoreInstructions(
	instructions: string,
	signature: import("../signature.js").Signature,
	dataset: Example[],
	lm: LanguageModelAdapter,
	metric: Metric,
): Promise<number> {
	if (dataset.length === 0) return 0;
	const predict = new Predict({
		signature,
		lm,
		instructionsOverride: instructions,
	});
	let total = 0;
	for (const example of dataset) {
		try {
			const { output } = await predict.forward(example.inputs);
			total += metric(output, example.outputs);
		} catch {
			// Parse failure is a real failure for scoring. No silent fallback.
		}
	}
	return total / dataset.length;
}

function subsample<T>(items: T[], count: number, rng: () => number): T[] {
	if (count >= items.length) return [...items];
	const indices = new Set<number>();
	const out: T[] = [];
	while (out.length < count) {
		const idx = Math.floor(rng() * items.length);
		if (indices.has(idx)) continue;
		indices.add(idx);
		const item = items[idx];
		if (item !== undefined) out.push(item);
	}
	return out;
}
