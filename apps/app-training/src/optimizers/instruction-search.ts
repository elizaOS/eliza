/**
 * MIPRO-style instruction search optimizer.
 *
 * Iterative improvement loop:
 *   1. Ask the LLM to propose N rewrites of the current baseline prompt that
 *      preserve the task contract but tighten language, add guardrails, or
 *      reorder for clarity.
 *   2. Score each candidate (plus the current baseline) on a held-out subset
 *      of the dataset.
 *   3. Keep the highest-scoring candidate as the next round's baseline.
 *   4. Repeat for `rounds` iterations.
 *
 * Returns the best prompt observed across all rounds along with full lineage
 * (every (round, variant) -> score), so the caller can render an audit trail.
 */

import { subsample } from "./scoring.js";
import type {
	LlmAdapter,
	OptimizationExample,
	OptimizerLineageEntry,
	OptimizerResult,
	PromptScorer,
} from "./types.js";

export interface InstructionSearchOptions {
	/** Variants to propose per round. Defaults to 8. */
	variants?: number;
	/** Search rounds. Defaults to 3. */
	rounds?: number;
	/** Held-out examples scored per candidate. Defaults to all examples. */
	scoringSubset?: number;
	/** Sampling temperature for variant generation. Defaults to 0.7. */
	temperature?: number;
	/** Max tokens for the rewrite completion. Defaults to 1024. */
	maxTokens?: number;
	/** Deterministic RNG override (tests). Defaults to Math.random. */
	rng?: () => number;
}

export interface InstructionSearchInput {
	baselinePrompt: string;
	dataset: OptimizationExample[];
	scorer: PromptScorer;
	llm: LlmAdapter;
	options?: InstructionSearchOptions;
}

const REWRITE_INSTRUCTIONS = `You are a prompt engineer. Improve the SYSTEM PROMPT below for the task it describes.

Constraints:
- Preserve the original task contract (inputs, outputs, format).
- Keep all literal placeholders like {{agentName}} or {{providers}} intact.
- Do not invent new fields, do not remove existing ones.
- Tighten language, add guardrails for failure modes, reorder for clarity.
- Output ONLY the rewritten prompt. No commentary, no fenced code blocks.`;

export async function runInstructionSearch(
	input: InstructionSearchInput,
): Promise<OptimizerResult> {
	const variants = input.options?.variants ?? 8;
	const rounds = input.options?.rounds ?? 3;
	const temperature = input.options?.temperature ?? 0.7;
	const maxTokens = input.options?.maxTokens ?? 1024;
	const rng = input.options?.rng ?? Math.random;
	const lineage: OptimizerLineageEntry[] = [];

	const heldOut =
		typeof input.options?.scoringSubset === "number"
			? subsample(input.dataset, input.options.scoringSubset, rng)
			: input.dataset;

	const baselineScore = await input.scorer(input.baselinePrompt, heldOut);
	lineage.push({ round: 0, variant: 0, score: baselineScore, notes: "baseline" });

	let bestPrompt = input.baselinePrompt;
	let bestScore = baselineScore;
	let currentBaseline = input.baselinePrompt;

	for (let round = 1; round <= rounds; round += 1) {
		let roundBestPrompt = currentBaseline;
		let roundBestScore = bestScore;
		for (let variant = 1; variant <= variants; variant += 1) {
			const candidate = await input.llm.complete({
				system: REWRITE_INSTRUCTIONS,
				user: currentBaseline,
				temperature,
				maxTokens,
			});
			const cleaned = candidate.trim();
			if (cleaned.length === 0) {
				lineage.push({
					round,
					variant,
					score: 0,
					notes: "empty rewrite — skipped",
				});
				continue;
			}
			const score = await input.scorer(cleaned, heldOut);
			lineage.push({ round, variant, score });
			if (score > roundBestScore) {
				roundBestScore = score;
				roundBestPrompt = cleaned;
			}
		}
		if (roundBestScore > bestScore) {
			bestScore = roundBestScore;
			bestPrompt = roundBestPrompt;
		}
		// Carry the round winner forward as the next round's seed; this is the
		// MIPRO greedy step. If no candidate improved, we still move forward to
		// give the next round a chance with the same seed.
		currentBaseline = roundBestPrompt;
	}

	return {
		optimizedPrompt: bestPrompt,
		score: bestScore,
		baseline: baselineScore,
		lineage,
	};
}
