/**
 * In-process streaming-LLM runner.
 *
 * FFI streaming-LLM ABI declared in `ffi-streaming-llm.h`. The
 * token-by-token loop hands `onTextChunk` accepted chunks and surfaces
 * verifier events from native MTP.
 *
 * This file deliberately does not own the FFI context or the binding
 * itself. It takes a narrow `LlmStreamingBinding` (see
 * `services/llm-streaming-binding.ts`) + an opaque `LlmCtxHandle` as
 * constructor arguments — that way it can be driven by libelizainference
 * (via `wrapElizaInferenceFfi`) or any desktop libllama shim adapter without
 * dragging in TTS/ASR surfaces. A single context can host concurrent generation
 * sessions (one per pinned slot); the runner serialises with
 * `slotInFlight`.
 *
 * Single-flight: lock map keyed by slot id, slot id `-1` unlocked. Two concurrent generates
 * against the same pinned slot would interleave KV cache state, so the
 * runner serializes them at the JS layer.
 */

import { performance } from "node:perf_hooks";

import type {
	LlmCtxHandle,
	LlmStreamingBinding,
} from "./llm-streaming-binding";
import type { LlmStreamHandle, LlmStreamStep } from "./voice/ffi-bindings";
import type { TextToken, VerifierStreamEvent } from "./voice/types";

export interface FfiStreamingGenerateArgs {
	/** Pre-tokenized prompt — the runner does not detokenize. */
	promptTokens: Int32Array;
	/** Pinned slot id; -1 disables pinning (any free slot). */
	slotId: number;
	/** Optional prompt cache key used to derive a slot when `slotId === -1`. */
	cacheKey?: string;
	maxTokens: number;
	temperature: number;
	topP: number;
	topK: number;
	repeatPenalty: number;
	draftMin: number;
	draftMax: number;
	/** Reserved for separate draft-model speculation; null for Eliza-1 MTP. */
	draftModelPath: string | null;
	/**
	 * Per-load GPU offload (ABI v8). Forwarded into the native session config
	 * on `llmStreamOpen`. The fused libelizainference path loads the text model
	 * once per ctx, so the FIRST session's value wins; later sessions reuse the
	 * resident model. `undefined` selects the runtime default (all layers).
	 * The desktop libllama path already applies gpuLayers at `loadModel()`, so
	 * it ignores this field — it is load-time config, threaded here only so the
	 * fused runner can mirror the libllama load decision.
	 */
	gpuLayers?: number;
	/**
	 * KV-cache K/V quant type names (ABI v8), e.g. "qjl1_256" / "q4_polar".
	 * Same load-time semantics as `gpuLayers`: forwarded into the fused
	 * session config so the first `llmStreamOpen` applies the quantized cache.
	 */
	cacheTypeK?: string | null;
	cacheTypeV?: string | null;
	/**
	 * Runtime context window in tokens (ABI v9). Forwarded into the fused
	 * session config on `llmStreamOpen`; `undefined` keeps the native
	 * ELIZA_LLM_N_CTX/default fallback.
	 */
	contextSize?: number;
	/**
	 * GBNF grammar source forcing the structured-reply envelope. Passed to
	 * the native session's `llmStreamOpen` config so sampling is
	 * grammar-constrained. `null` disables the constraint (free generation).
	 */
	gbnfGrammar?: string | null;
	/** Cancellation signal — fires `llmStreamCancel` on the active session. */
	signal?: AbortSignal;
	/**
	 * Per-step token cap for the native decode loop. Lower values make the
	 * local UI stream in finer-grained jumps (smoother token-by-token render)
	 * at the cost of more JS↔FFI round-trips per reply; higher values batch
	 * more tokens per step. When omitted, falls back to
	 * `resolveMaxTokensPerStep()` (env `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP`,
	 * else `DEFAULT_MAX_TOKENS_PER_STEP`). Clamped to
	 * `[MIN_MAX_TOKENS_PER_STEP, MAX_MAX_TOKENS_PER_STEP]`.
	 */
	maxTokensPerStep?: number;
	/** Per-chunk text callback. */
	onTextChunk?: (chunk: string) => void | Promise<void>;
	/** Speculative accept/reject events from MTP verification. */
	onVerifierEvent?: (event: VerifierStreamEvent) => void | Promise<void>;
}

export interface FfiStreamingGenerateResult {
	text: string;
	slotId: number;
	firstTokenMs: number | null;
	drafted: number;
	accepted: number;
}

/** Default per-step caps. Match upstream llama-server's `n_predict` chunk size. */
const DEFAULT_MAX_TOKENS_PER_STEP = 32;
const DEFAULT_MAX_TEXT_BYTES = 1024;
/**
 * Sane bounds for the per-step token cap. The floor is 1 (true
 * token-by-token); the ceiling guards against pathological values that would
 * defeat streaming by emitting the whole reply in one step.
 */
const MIN_MAX_TOKENS_PER_STEP = 1;
const MAX_MAX_TOKENS_PER_STEP = 512;

/** Clamp a caller-supplied per-step cap into the supported range. */
function clampMaxTokensPerStep(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_MAX_TOKENS_PER_STEP;
	return Math.min(
		MAX_MAX_TOKENS_PER_STEP,
		Math.max(MIN_MAX_TOKENS_PER_STEP, Math.trunc(value)),
	);
}

/**
 * Resolve the per-step token cap for the native decode loop. Override via the
 * `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP` env var (e.g. set to `8` for smoother
 * local streaming, weighed against the extra JS↔FFI round-trips and the shared
 * voice phrase-chunker). Falls back to `DEFAULT_MAX_TOKENS_PER_STEP` (32) when
 * unset or invalid; clamped to `[MIN_MAX_TOKENS_PER_STEP, MAX_MAX_TOKENS_PER_STEP]`.
 */
export function resolveMaxTokensPerStep(): number {
	const raw = process.env.ELIZA_LOCAL_STREAM_TOKENS_PER_STEP?.trim();
	if (!raw) return DEFAULT_MAX_TOKENS_PER_STEP;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS_PER_STEP;
	return clampMaxTokensPerStep(parsed);
}

/**
 * Backend used by the mobile and desktop FFI routes.
 */
export class FfiStreamingRunner {
	private readonly slotInFlight = new Map<number, Promise<void>>();

	/**
	 * Constructor takes the narrow `LlmStreamingBinding` (see
	 * `services/llm-streaming-binding.ts`) so both libelizainference (via
	 * `wrapElizaInferenceFfi`) and desktop libllama adapters can
	 * satisfy it. The runner never touches TTS/ASR/mmap surfaces.
	 */
	constructor(
		private readonly ffi: LlmStreamingBinding,
		private readonly ctx: LlmCtxHandle,
	) {}

	/**
	 * Run one generation. Mirrors `MtpLlamaServer.generateWithUsage()`
	 * — same single-flight rule, same callback shape, same result block
	 * minus the metrics scrape (FFI does not have a `/metrics` endpoint).
	 */
	async generateWithUsage(
		args: FfiStreamingGenerateArgs,
	): Promise<FfiStreamingGenerateResult> {
		return this.withSlotLock(args.slotId, () => this.runGenerate(args));
	}

	/**
	 * Serialize `fn` behind any in-flight generation on the same pinned slot.
	 * Slot id `-1` (unpinned) runs immediately. Both `generateWithUsage` and
	 * `generateStream` route through here — two concurrent generations against
	 * the same pinned slot would interleave the slot's KV cache state.
	 */
	private async withSlotLock<T>(
		slotId: number,
		fn: () => Promise<T>,
	): Promise<T> {
		if (slotId < 0) {
			return fn();
		}
		const prior = this.slotInFlight.get(slotId);
		// error-policy:J5 unhandled-rejection suppression — the prior slot user's
		// failure was already observed by that caller (it awaited its own `run`).
		// Here we only serialize behind its completion; swallowing its rejection
		// keeps one generation's failure from blocking the next on the same slot.
		const run = (prior ?? Promise.resolve()).catch(() => {}).then(fn);
		const tail = run.then(
			() => {},
			() => {},
		);
		this.slotInFlight.set(slotId, tail);
		try {
			return await run;
		} finally {
			if (this.slotInFlight.get(slotId) === tail) {
				this.slotInFlight.delete(slotId);
			}
		}
	}

	/**
	 * Async-iterable variant. Yields each accepted-token batch as it lands
	 * so callers that want token-grained control (e.g. the voice scheduler
	 * driving phrase-chunking off accept/reject events) don't have to
	 * register a callback. The pump acquires the same per-slot lock as
	 * `generateWithUsage`, so the single-flight rule applies to streams too.
	 */
	async *generateStream(
		args: FfiStreamingGenerateArgs,
	): AsyncIterable<LlmStreamStep> {
		// Queue accumulates steps the inner callback produces; the iterator
		// drains it. Using a plain array + resolver is simpler than wiring a
		// real async-queue for the single-consumer case here.
		const queue: LlmStreamStep[] = [];
		let resume: (() => void) | null = null;
		let finished = false;
		let failure: Error | null = null;

		const wakeConsumer = () => {
			const wake = resume;
			resume = null;
			if (wake) wake();
		};

		const onStep = (step: LlmStreamStep) => {
			queue.push(step);
			wakeConsumer();
		};

		const work = this.withSlotLock(args.slotId, async () => {
			try {
				await this.runGenerateInner(args, onStep);
			} catch (err) {
				failure = err instanceof Error ? err : new Error(String(err));
			} finally {
				finished = true;
				wakeConsumer();
			}
		});

		try {
			while (true) {
				if (queue.length > 0) {
					const next = queue.shift();
					if (next === undefined) continue;
					yield next;
					if (next.done) return;
					continue;
				}
				if (failure) throw failure;
				if (finished) return;
				await new Promise<void>((resolve) => {
					resume = resolve;
				});
			}
		} finally {
			await work;
		}
	}

	/**
	 * Save the streaming slot KV state to disk. Best called between turns
	 * — calling mid-stream is racy and the FFI side is allowed to refuse.
	 * Surfaced here so the conversation registry can persist between
	 * mobile backgrounds the same way `MtpLlamaServer.persistSlot` does.
	 */
	saveSlot(stream: LlmStreamHandle, filename: string): void {
		if (this.ffi.llmStreamSaveSlot === undefined) {
			throw new Error(
				"[ffi-streaming-runner] llmStreamSaveSlot is not exported by this build",
			);
		}
		this.ffi.llmStreamSaveSlot({ stream, filename });
	}

	/** Restore a previously-saved slot KV file into a fresh session. */
	restoreSlot(stream: LlmStreamHandle, filename: string): void {
		if (this.ffi.llmStreamRestoreSlot === undefined) {
			throw new Error(
				"[ffi-streaming-runner] llmStreamRestoreSlot is not exported by this build",
			);
		}
		this.ffi.llmStreamRestoreSlot({ stream, filename });
	}

	/* ----- internals -------------------------------------------------- */

	private async runGenerate(
		args: FfiStreamingGenerateArgs,
	): Promise<FfiStreamingGenerateResult> {
		const aggregated: string[] = [];
		let totalDrafted = 0;
		let totalAccepted = 0;
		let firstTokenMs: number | null = null;
		const startedAt = performance.now();

		await this.runGenerateInner(args, (step) => {
			if (step.text.length > 0 && firstTokenMs === null) {
				firstTokenMs = performance.now() - startedAt;
			}
			aggregated.push(step.text);
			totalDrafted += step.drafterDrafted;
			totalAccepted += step.drafterAccepted;
		});

		return {
			text: aggregated.join(""),
			slotId: args.slotId,
			firstTokenMs,
			drafted: totalDrafted,
			accepted: totalAccepted,
		};
	}

	/**
	 * Shared inner loop. Opens the session, runs the prefill + next pump,
	 * forwards each step through `onStep` plus the optional caller
	 * callbacks, and wires abort + cancel.
	 */
	private async runGenerateInner(
		args: FfiStreamingGenerateArgs,
		onStep: (step: LlmStreamStep) => void,
	): Promise<void> {
		if (
			this.ffi.llmStreamOpen === undefined ||
			this.ffi.llmStreamPrefill === undefined ||
			this.ffi.llmStreamNext === undefined ||
			this.ffi.llmStreamClose === undefined
		) {
			throw new Error(
				"[ffi-streaming-runner] libelizainference is missing streaming-LLM symbols. " +
					"Rebuild against the current eliza-inference-ffi.h.",
			);
		}

		const stream = this.ffi.llmStreamOpen({
			ctx: this.ctx,
			config: {
				maxTokens: args.maxTokens,
				temperature: args.temperature,
				topP: args.topP,
				topK: args.topK,
				repeatPenalty: args.repeatPenalty,
				slotId: args.slotId,
				promptCacheKey: args.cacheKey ?? null,
				draftMin: args.draftMin,
				draftMax: args.draftMax,
				draftModelPath: args.draftModelPath,
				gbnfGrammar: args.gbnfGrammar ?? null,
				gpuLayers: args.gpuLayers,
				cacheTypeK: args.cacheTypeK,
				cacheTypeV: args.cacheTypeV,
				contextSize: args.contextSize,
			},
		});

		let abortListener: (() => void) | null = null;
		if (args.signal) {
			if (args.signal.aborted) {
				this.ffi.llmStreamCancel?.(stream);
				this.ffi.llmStreamClose(stream);
				throw new Error("[ffi-streaming-runner] aborted before start");
			}
			abortListener = () => {
				this.ffi.llmStreamCancel?.(stream);
			};
			args.signal.addEventListener("abort", abortListener, { once: true });
		}

		try {
			this.ffi.llmStreamPrefill({ stream, tokens: args.promptTokens });
			if (args.maxTokens <= 0) {
				return;
			}

			const maxTokensPerStep =
				args.maxTokensPerStep !== undefined
					? clampMaxTokensPerStep(args.maxTokensPerStep)
					: resolveMaxTokensPerStep();

			let tokenIndex = 0;
			while (true) {
				if (args.signal?.aborted) {
					this.ffi.llmStreamCancel?.(stream);
					throw new Error("[ffi-streaming-runner] aborted");
				}
				const step = this.ffi.llmStreamNext({
					stream,
					maxTokensPerStep,
					maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
				});
				onStep(step);

				if (args.onTextChunk && step.text.length > 0) {
					await args.onTextChunk(step.text);
				}
				if (args.onVerifierEvent) {
					const tokens: TextToken[] = step.tokens.map((id, i) => ({
						index: tokenIndex + i,
						text: i === 0 ? step.text : "",
						id,
					}));
					// The FFI ABI commits accepted tokens per step (the drafter
					// accept/reject decomposition is delivered through the
					// separate `setVerifierCallback` channel — see ffi.h §v2).
					// Surface the batched accept here so HTTP-path callers see a
					// matching event shape.
					if (tokens.length > 0) {
						await args.onVerifierEvent({
							kind: "accept",
							tokens,
						});
					}
				}
				tokenIndex += step.tokens.length;
				if (step.done) break;
			}
		} finally {
			if (abortListener && args.signal) {
				args.signal.removeEventListener("abort", abortListener);
			}
			this.ffi.llmStreamClose(stream);
		}
	}
}
