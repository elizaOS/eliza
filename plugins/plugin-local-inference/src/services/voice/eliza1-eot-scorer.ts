/**
 * Eliza-1 EOT scorer — reuses the already-loaded text model to compute
 * P(the loaded model's turn terminator next | conversation_so_far) without
 * shipping a separate detector ONNX.
 *
 * The runtime keeps a `LlamaModel` resident for chat generation. Voice
 * EOT scoring is a single forward pass over the formatted Gemma chat
 * prompt with its trailing turn terminator omitted. `capacitor-llama`'s
 * `LlamaContextSequence.controlledEvaluate()` returns the next-token
 * probability distribution, so we simply read the entry for the
 * resolved terminator token id — no sampling loop, no KV-cache growth on the
 * chat session.
 *
 * A dedicated `LlamaContext` is held just for this scorer so we do not
 * fight the chat session pool for sequence slots. The context is small
 * (single sequence, ≤512 tokens) and shares the model weights with the
 * chat path; only the per-sequence KV cache is duplicated.
 *
 * Optionally a LoRA adapter is attached to that context — that is how
 * a fine-tuned EOT head (trained per
 * `packages/training/scripts/turn_detector/`) layers onto the same base
 * weights without a separate GGUF.
 */

import path from "node:path";
import {
	formatEotPrompt,
	type ResolvedEotTokenContract,
	resolveEotTokenContract,
} from "./eot-token-contract";

export { formatEotPrompt } from "./eot-token-contract";

// `capacitor-llama` 3.18.1 surface we depend on. We avoid importing the
// type directly so the binding stays an optional peer dep — callers pass
// the model through a structural type.
export interface LlamaModelLike {
	tokenize(text: string, specialTokens?: boolean): readonly number[];
	createContext(options: {
		contextSize?: number;
		sequences?: number;
		flashAttention?: boolean;
		lora?: string | { adapters: Array<{ filePath: string; scale?: number }> };
	}): Promise<LlamaContextLike>;
}

export interface LlamaContextLike {
	getSequence(options?: object): LlamaContextSequenceLike;
	dispose(): Promise<void>;
}

export interface LlamaContextSequenceLike {
	clearHistory(): Promise<void>;
	controlledEvaluate(
		input: ControlledEvaluateInputLike[],
		options?: { evaluationPriority?: number },
	): Promise<Array<ControlledEvaluateOutputLike | undefined>>;
}

export type ControlledEvaluateInputLike =
	| number
	| [
			token: number,
			options: {
				generateNext?: {
					probabilities?: boolean;
					confidence?: boolean;
				};
			},
	  ];

export interface ControlledEvaluateOutputLike {
	next: {
		token?: number | null;
		confidence?: number;
		probabilities?: Map<number, number>;
	};
}

export interface Eliza1EotScorerOptions {
	/** The already-loaded text model (eliza-1 drafter). */
	model: LlamaModelLike;
	/** Optional EOT LoRA adapter path (absolute). When set, applied to the dedicated EOT context. */
	loraPath?: string;
	/** Adapter scale (default 1.0). Only meaningful when `loraPath` is set. */
	loraScale?: number;
	/** Context size for the dedicated EOT context. Default 512. */
	contextSize?: number;
	/** Model label for telemetry. */
	modelLabel?: string;
}

export interface Eliza1EotScoreResult {
	/** Probability of the loaded model's turn terminator as the next token, ∈ [0, 1]. */
	probability: number;
	/** Wall-clock model latency for this scoring call. */
	latencyMs: number;
	/** Number of prompt tokens evaluated. */
	promptTokens: number;
}

/**
 * Stateful EOT scorer bound to a single loaded text model. Lazily
 * allocates its own dedicated `LlamaContext` on first call. Safe to
 * keep across many voice turns; call `dispose()` on shutdown.
 */
export class Eliza1EotScorer {
	private readonly model: LlamaModelLike;
	private readonly loraPath: string | undefined;
	private readonly loraScale: number | undefined;
	private readonly contextSize: number;
	readonly modelLabel: string;

	private context: LlamaContextLike | null = null;
	private sequence: LlamaContextSequenceLike | null = null;
	private tokenContract: ResolvedEotTokenContract | null = null;
	private initPromise: Promise<void> | null = null;
	/** Serializes concurrent calls — controlledEvaluate is not thread-safe per-sequence. */
	private inflight: Promise<unknown> = Promise.resolve();

	constructor(options: Eliza1EotScorerOptions) {
		this.model = options.model;
		this.loraPath = options.loraPath;
		this.loraScale = options.loraScale;
		this.contextSize = options.contextSize ?? 512;
		this.modelLabel =
			options.modelLabel ??
			(this.loraPath
				? `eliza-1-drafter+eot-lora:${path.basename(this.loraPath)}`
				: "eliza-1-drafter");
	}

	async score(partialTranscript: string): Promise<Eliza1EotScoreResult> {
		await this.ensureReady();
		const sequence = this.sequence;
		const tokenContract = this.tokenContract;
		if (!sequence || tokenContract === null) {
			throw new Error("[voice] Eliza1EotScorer not initialized.");
		}

		const tokens = this.tokenizePrompt(partialTranscript, tokenContract);
		const start = performance.now();
		const next = this.inflight.then(() =>
			this.runOnce(sequence, tokens, tokenContract.closingTokenId),
		);
		// error-policy:J5 unhandled-rejection suppression — the real failure is
		// observed by `await next` on the following line (and rethrown to the
		// caller). `this.inflight` only serializes the next scoring call behind
		// this one, so it stores a settled-either-way promise and must not carry
		// the rejection forward.
		this.inflight = next.catch(() => undefined);
		const probability = await next;
		return {
			probability,
			latencyMs: performance.now() - start,
			promptTokens: tokens.length,
		};
	}

	async dispose(): Promise<void> {
		const ctx = this.context;
		this.context = null;
		this.sequence = null;
		this.tokenContract = null;
		this.initPromise = null;
		if (ctx) await ctx.dispose();
	}

	private async ensureReady(): Promise<void> {
		if (this.context && this.sequence && this.tokenContract !== null) return;
		if (!this.initPromise) this.initPromise = this.initialize();
		await this.initPromise;
	}

	private async initialize(): Promise<void> {
		this.tokenContract = resolveEotTokenContract((text) =>
			this.model.tokenize(text, true),
		);

		const contextOptions: Parameters<LlamaModelLike["createContext"]>[0] = {
			contextSize: this.contextSize,
			sequences: 1,
			flashAttention: true,
		};
		if (this.loraPath) {
			contextOptions.lora = {
				adapters: [
					{
						filePath: this.loraPath,
						...(this.loraScale !== undefined ? { scale: this.loraScale } : {}),
					},
				],
			};
		}

		this.context = await this.model.createContext(contextOptions);
		this.sequence = this.context.getSequence();
	}

	private tokenizePrompt(
		transcript: string,
		contract: ResolvedEotTokenContract,
	): number[] {
		const formatted = formatEotPrompt(transcript, contract);
		const ids = this.model.tokenize(formatted, true);
		if (ids.length > this.contextSize) {
			throw new RangeError(
				`[voice] Eliza1EotScorer: complete prompt requires ${ids.length} tokens, exceeding the dedicated ${this.contextSize}-token context.`,
			);
		}
		return [...ids];
	}

	private async runOnce(
		sequence: LlamaContextSequenceLike,
		tokens: number[],
		endOfTurnId: number,
	): Promise<number> {
		if (tokens.length === 0) return 0.5;
		await sequence.clearHistory();
		const input: ControlledEvaluateInputLike[] = tokens.map((tok, i) =>
			i === tokens.length - 1
				? [tok, { generateNext: { probabilities: true } }]
				: tok,
		);
		const out = await sequence.controlledEvaluate(input);
		const last = out[tokens.length - 1];
		const probs = last?.next.probabilities;
		if (!probs) return 0.5;
		const p = probs.get(endOfTurnId);
		if (typeof p !== "number" || !Number.isFinite(p)) return 0.5;
		return Math.max(0, Math.min(1, p));
	}
}
