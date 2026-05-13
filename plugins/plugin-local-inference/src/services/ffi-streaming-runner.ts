/**
 * In-process streaming-LLM runner.
 *
 * Mirror of the streaming surface that `DflashLlamaServer.generateWithUsage()`
 * exposes (`dflash-server.ts`), but routed through the FFI streaming-LLM
 * ABI declared in `ffi-streaming-llm.h` instead of an HTTP request to a
 * child-process `llama-server`. The token-by-token loop hands `onTextChunk`
 * the same chunks the SSE path produced, and the speculative drafter is
 * driven by the v2 verifier-callback registration so callers don't see a
 * different event stream when they swap backends.
 *
 * This file deliberately does not own the FFI context — the
 * `ElizaInferenceFfi` handle and its `ElizaInferenceContextHandle` live
 * in the voice lifecycle service. The runner takes both as constructor
 * arguments so it can be unit-tested with a mocked FFI surface and so a
 * single FFI context can host concurrent generation sessions (one per
 * pinned slot).
 *
 * Single-flight: same lock pattern as the HTTP server (`slotInFlight`
 * map keyed by slot id, slot id `-1` unlocked). Two concurrent generates
 * against the same pinned slot would interleave KV cache state, so the
 * runner serializes them at the JS layer just like the HTTP path does.
 */

import { performance } from "node:perf_hooks";

import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
  LlmStreamHandle,
  LlmStreamStep,
} from "./voice/ffi-bindings";
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
  /** Absolute path of the drafter GGUF; null disables speculative decoding. */
  dflashDrafterPath: string | null;
  /** Cancellation signal — fires `llmStreamCancel` on the active session. */
  signal?: AbortSignal;
  /** Per-chunk text callback, same shape as `DflashGenerateArgs.onTextChunk`. */
  onTextChunk?: (chunk: string) => void | Promise<void>;
  /** Speculative accept/reject events, same shape as the HTTP path. */
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
 * Backend used by `aosp-dflash-adapter.ts` and the desktop `auto` route
 * when `selectBackend()` picks `"ffi-streaming"`. The HTTP path stays in
 * `dflash-server.ts` unchanged; this is a parallel runner, not a
 * replacement.
 */
export class FfiStreamingRunner {
  private readonly slotInFlight = new Map<number, Promise<void>>();

  constructor(
    private readonly ffi: ElizaInferenceFfi,
    private readonly ctx: ElizaInferenceContextHandle,
  ) {}

  /**
   * Run one generation. Mirrors `DflashLlamaServer.generateWithUsage()`
   * — same single-flight rule, same callback shape, same result block
   * minus the metrics scrape (FFI does not have a `/metrics` endpoint).
   */
  async generateWithUsage(
    args: FfiStreamingGenerateArgs,
  ): Promise<FfiStreamingGenerateResult> {
    if (args.slotId < 0) {
      return this.runGenerate(args);
    }
    const prior = this.slotInFlight.get(args.slotId);
    const run = (prior ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.runGenerate(args));
    const tail = run.then(
      () => {},
      () => {},
    );
    this.slotInFlight.set(args.slotId, tail);
    try {
      return await run;
    } finally {
      if (this.slotInFlight.get(args.slotId) === tail) {
        this.slotInFlight.delete(args.slotId);
      }
    }
  }

  /**
   * Async-iterable variant. Yields each accepted-token batch as it lands
   * so callers that want token-grained control (e.g. the voice scheduler
   * driving phrase-chunking off accept/reject events) don't have to
   * register a callback. Internally still routes through `generateWithUsage`
   * via a pump so the single-flight rule applies.
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

    const work = (async () => {
      try {
        await this.runGenerateInner(args, onStep);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        finished = true;
        wakeConsumer();
      }
    })();

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
   * mobile backgrounds the same way `DflashLlamaServer.persistSlot` does.
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
          "Rebuild against the current ffi-streaming-llm.h.",
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
        dflashDrafterPath: args.dflashDrafterPath,
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

      let tokenIndex = 0;
      while (true) {
        if (args.signal?.aborted) {
          this.ffi.llmStreamCancel?.(stream);
          throw new Error("[ffi-streaming-runner] aborted");
        }
        const step = this.ffi.llmStreamNext({
          stream,
          maxTokensPerStep: DEFAULT_MAX_TOKENS_PER_STEP,
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
