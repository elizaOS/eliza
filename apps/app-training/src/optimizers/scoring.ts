/**
 * Scoring utilities for native optimizers.
 *
 * The default scorer measures token-overlap agreement between the model's
 * actual output and the expected output recorded in the trajectory dataset.
 * It is deliberately cheap and deterministic — the optimizers run hundreds
 * of completions per round, so we cannot afford a model-graded scorer.
 *
 * Token-overlap agreement (Jaccard over normalized tokens) is the same primitive
 * that `replay-validator.ts` uses for `scoreSkill`-style success measurement,
 * just lifted to the (output vs reference) comparison instead of (skill vs
 * trajectory). When a richer signal becomes available — e.g. a structured
 * TOON parser per task — the scorer factory can be swapped without changing
 * any optimizer code.
 */

import type {
	LlmAdapter,
	OptimizationExample,
	PromptScorer,
} from "./types.js";

interface ScorerOptions {
	/** Cap on examples scored per call. Defaults to all examples. */
	maxExamples?: number;
	/** Temperature passed to the adapter. Defaults to 0 for determinism. */
	temperature?: number;
	/** Max tokens for each completion. Defaults to 512. */
	maxTokens?: number;
}

/**
 * Build a `PromptScorer` backed by a real LLM adapter.
 *
 * For each example:
 *   1. Run `prompt` (as system) + `example.input.user` through the adapter.
 *   2. Compare the completion against `example.expectedOutput` via Jaccard
 *      similarity over normalized tokens.
 *   3. Return the mean score.
 *
 * Reuses the same normalization heuristic as the trajectory-task-datasets
 * exporter (lower-case, strip punctuation, drop empty tokens).
 */
export function createPromptScorer(
	adapter: LlmAdapter,
	options: ScorerOptions = {},
): PromptScorer {
	const temperature = options.temperature ?? 0;
	const maxTokens = options.maxTokens ?? 512;
	return async (prompt, examples) => {
		if (examples.length === 0) return 0;
		const cap = options.maxExamples ?? examples.length;
		const limited = examples.slice(0, Math.max(1, cap));
		let total = 0;
		for (const example of limited) {
			const completion = await adapter.complete({
				system: prompt,
				user: example.input.user,
				temperature,
				maxTokens,
			});
			total += scoreAgreement(completion, example.expectedOutput);
		}
		return total / limited.length;
	};
}

/**
 * Jaccard similarity over normalized token sets, in `[0, 1]`. Empty inputs
 * collapse to 0 (no overlap to measure).
 */
export function scoreAgreement(actual: string, expected: string): number {
	const actualTokens = tokenize(actual);
	const expectedTokens = tokenize(expected);
	if (expectedTokens.size === 0 && actualTokens.size === 0) return 1;
	if (expectedTokens.size === 0 || actualTokens.size === 0) return 0;
	let intersection = 0;
	for (const token of actualTokens) {
		if (expectedTokens.has(token)) intersection += 1;
	}
	const union = actualTokens.size + expectedTokens.size - intersection;
	if (union === 0) return 0;
	return intersection / union;
}

function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]+/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 0);
	return new Set(tokens);
}

/**
 * Random-without-replacement subsample, used by optimizer rounds to keep
 * scoring cheap on large datasets without sacrificing comparability across
 * rounds (deterministic when `rng` is supplied).
 */
export function subsample<T>(
	items: T[],
	count: number,
	rng: () => number = Math.random,
): T[] {
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

/**
 * Wraps `IAgentRuntime.useModel` into the `LlmAdapter` shape. We accept a
 * loose runtime type so this module stays free of `@elizaos/core` import
 * cycles — the native backend supplies the bound `useModel` directly.
 */
export interface UseModelHandler {
	(input: {
		prompt: string;
		temperature?: number;
		maxTokens?: number;
	}): Promise<string | object | undefined>;
}

export function createRuntimeAdapter(useModel: UseModelHandler): LlmAdapter {
	return {
		async complete(input) {
			const composed = input.system
				? `${input.system}\n\n${input.user}`
				: input.user;
			const response = await useModel({
				prompt: composed,
				temperature: input.temperature,
				maxTokens: input.maxTokens,
			});
			if (typeof response === "string") return response;
			if (response === undefined || response === null) return "";
			return JSON.stringify(response);
		},
	};
}
