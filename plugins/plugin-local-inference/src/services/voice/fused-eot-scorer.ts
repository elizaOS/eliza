/**
 * Fused FFI end-of-turn scorer (ABI v11).
 *
 * The fused replacement for the retired node-llama-cpp `controlledEvaluate()`
 * path the EOT classifiers depended on. Computes P(the loaded model's turn
 * terminator next | partial transcript) through the single
 * `libelizainference` handle: resolve the paired turn tokens, tokenize the
 * partial-turn prompt, then run one causal forward pass. The dedicated native
 * scoring context clears its KV per call, so scores are independent without a
 * separate model, sampling loop, or growth on the chat session's KV cache.
 */

import {
	formatEotPrompt,
	type ResolvedEotTokenContract,
	resolveEotTokenContract,
} from "./eot-token-contract";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./ffi-bindings";

export interface FfiEotScorerOptions {
	/** The loaded fused inference binding (must expose the v11 EOT symbols). */
	ffi: ElizaInferenceFfi;
	/** Resolves the live inference context handle (the loaded text bundle). */
	getContext: () => ElizaInferenceContextHandle;
	/** Model label for telemetry. */
	modelLabel?: string;
}

export interface FfiEotScoreResult {
	/** Probability of the loaded model's turn terminator as the next token, ∈ [0, 1]. */
	probability: number;
	/** Wall-clock model latency for this scoring call. */
	latencyMs: number;
	/** Number of prompt tokens evaluated. */
	promptTokens: number;
}

/**
 * Stateful EOT scorer bound to a loaded fused text model. Its paired turn-token
 * contract is resolved once and cached. Safe to keep across many voice turns.
 */
export class FfiEotScorer {
	private readonly ffi: ElizaInferenceFfi;
	private readonly getContext: () => ElizaInferenceContextHandle;
	readonly modelLabel: string;
	private tokenContract: ResolvedEotTokenContract | null = null;

	constructor(options: FfiEotScorerOptions) {
		this.ffi = options.ffi;
		this.getContext = options.getContext;
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

	private resolveTokenContract(
		ctx: ElizaInferenceContextHandle,
	): ResolvedEotTokenContract {
		if (this.tokenContract !== null) return this.tokenContract;
		const tokenize = this.ffi.tokenize;
		if (!tokenize) {
			throw new Error("[voice] FfiEotScorer: fused tokenizer is unavailable.");
		}
		this.tokenContract = resolveEotTokenContract((text) =>
			tokenize({ ctx, text, addSpecial: false, parseSpecial: true }),
		);
		return this.tokenContract;
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
		const tokenContract = this.resolveTokenContract(ctx);
		const formatted = formatEotPrompt(partialTranscript, tokenContract);
		const all = tokenize({
			ctx,
			text: formatted,
			addSpecial: false,
			parseSpecial: true,
		});
		if (all.length === 0) {
			return {
				probability: 0.5,
				latencyMs: performance.now() - start,
				promptTokens: 0,
			};
		}
		const { targetProb } = eotScore({
			ctx,
			tokens: all,
			targetTokenId: tokenContract.closingTokenId,
		});
		const probability = Number.isFinite(targetProb)
			? Math.max(0, Math.min(1, targetProb))
			: 0.5;
		return {
			probability,
			latencyMs: performance.now() - start,
			promptTokens: all.length,
		};
	}
}
