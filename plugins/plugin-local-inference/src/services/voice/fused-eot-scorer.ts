/**
 * Fused FFI end-of-turn scorer (ABI v11).
 *
 * The fused replacement for the retired node-llama-cpp `controlledEvaluate()`
 * path the EOT classifiers depended on. Computes P(`<end_of_turn>` next | partial
 * transcript) through the single `libelizainference` handle: tokenize the
 * Gemma-formatted partial transcript, then one causal forward pass
 * (`eliza_inference_llm_eot_score`) reads the next-token probability of the
 * end-of-turn marker. No separate model weights, no sampling loop, and no KV
 * growth on the chat session — the dedicated native scoring context clears its
 * KV per call so scores are independent.
 */

import { formatEotPrompt } from "./eliza1-eot-scorer";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./ffi-bindings";

const END_OF_TURN_TOKEN = "<end_of_turn>";

export interface FfiEotScorerOptions {
	/** The loaded fused inference binding (must expose the v11 EOT symbols). */
	ffi: ElizaInferenceFfi;
	/** Resolves the live inference context handle (the loaded text bundle). */
	getContext: () => ElizaInferenceContextHandle;
	/** Max prompt tokens kept (tail-truncated). LiveKit's recipe uses 128. */
	maxHistoryTokens?: number;
	/** Model label for telemetry. */
	modelLabel?: string;
}

export interface FfiEotScoreResult {
	/** Probability of `<end_of_turn>` as the next token, ∈ [0, 1]. */
	probability: number;
	/** Wall-clock model latency for this scoring call. */
	latencyMs: number;
	/** Number of prompt tokens evaluated. */
	promptTokens: number;
}

/**
 * Stateful EOT scorer bound to a loaded fused text model. The `<end_of_turn>`
 * token id is resolved once and cached. Safe to keep across many voice turns.
 */
export class FfiEotScorer {
	private readonly ffi: ElizaInferenceFfi;
	private readonly getContext: () => ElizaInferenceContextHandle;
	private readonly maxHistoryTokens: number;
	readonly modelLabel: string;
	private endOfTurnTokenId: number | null = null;

	constructor(options: FfiEotScorerOptions) {
		this.ffi = options.ffi;
		this.getContext = options.getContext;
		this.maxHistoryTokens = options.maxHistoryTokens ?? 128;
		this.modelLabel = options.modelLabel ?? "eliza-1-fused-eot";
	}

	/**
	 * True only when the fused build wires the v11 EOT scorer AND the tokenizer
	 * it depends on. A v10 (or older) library returns false.
	 */
	static isSupported(ffi: ElizaInferenceFfi | null | undefined): boolean {
		return (
			!!ffi &&
			typeof ffi.eotSupported === "function" &&
			ffi.eotSupported() &&
			typeof ffi.eotScore === "function" &&
			typeof ffi.tokenize === "function"
		);
	}

	private resolveEndOfTurn(ctx: ElizaInferenceContextHandle): number {
		if (this.endOfTurnTokenId !== null) return this.endOfTurnTokenId;
		const tokenize = this.ffi.tokenize;
		if (!tokenize) {
			throw new Error("[voice] FfiEotScorer: fused tokenizer is unavailable.");
		}
		const ids = tokenize({
			ctx,
			text: END_OF_TURN_TOKEN,
			addSpecial: false,
			parseSpecial: true,
		});
		const first = ids[0];
		if (ids.length !== 1 || first === undefined || !Number.isInteger(first)) {
			throw new Error(
				`[voice] FfiEotScorer: tokenizer did not resolve <end_of_turn> to a single special token (got ${JSON.stringify([...ids])}). The text bundle must be Gemma-template compatible.`,
			);
		}
		this.endOfTurnTokenId = first;
		return first;
	}

	async score(partialTranscript: string): Promise<FfiEotScoreResult> {
		const start = performance.now();
		const ctx = this.getContext();
		const tokenize = this.ffi.tokenize;
		const eotScore = this.ffi.eotScore;
		if (!tokenize || !eotScore) {
			throw new Error(
				"[voice] FfiEotScorer: fused EOT symbols are unavailable.",
			);
		}
		const endOfTurnId = this.resolveEndOfTurn(ctx);
		const formatted = formatEotPrompt(partialTranscript);
		const all = tokenize({
			ctx,
			text: formatted,
			addSpecial: false,
			parseSpecial: true,
		});
		const tokens =
			all.length > this.maxHistoryTokens
				? all.slice(all.length - this.maxHistoryTokens)
				: all;
		if (tokens.length === 0) {
			return {
				probability: 0.5,
				latencyMs: performance.now() - start,
				promptTokens: 0,
			};
		}
		const { targetProb } = eotScore({
			ctx,
			tokens,
			targetTokenId: endOfTurnId,
		});
		const probability = Number.isFinite(targetProb)
			? Math.max(0, Math.min(1, targetProb))
			: 0.5;
		return {
			probability,
			latencyMs: performance.now() - start,
			promptTokens: tokens.length,
		};
	}
}
