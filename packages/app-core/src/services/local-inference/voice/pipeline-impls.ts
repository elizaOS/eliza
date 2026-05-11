/**
 * Concrete implementations of the `VoicePipeline` seams (`pipeline.ts`).
 *
 * `pipeline.ts` defines three interfaces — `AsrTokenStreamer`,
 * `DraftProposer`, `TargetVerifier` — and an overlapped scheduler that
 * drives the fused mic→speech graph from `packages/inference/AGENTS.md`
 * §4. This module fills those interfaces against the live runtime:
 *
 *   - `StreamingTranscriberTokenStreamer` — the real ASR backend. Adapts a
 *     live frame-fed `StreamingTranscriber` (`voice/transcriber.ts`: fused
 *     `eliza_inference_asr_stream_*` → whisper.cpp interim) onto the
 *     pipeline's batch `transcribeStream` token-iterator: it feeds the
 *     whole utterance buffer, `flush()`es, and yields the final transcript
 *     split into contiguous text tokens. An optional `VadEventSource`
 *     (W1's `VadDetector`) gates decoding to active speech windows.
 *   - `FfiAsrTokenStreamer` — wraps the v1 batch ABI's ASR
 *     (`eliza_inference_asr_transcribe` via `ElizaInferenceFfi`) directly.
 *     Kept for callers/tests that drive the v1 symbol; the streaming
 *     adapter above is the preferred path.
 *   - `MissingAsrTranscriber` — hard-fails when no ASR backend is
 *     available (AGENTS.md §3 — no silent cloud fallback).
 *   - `LlamaServerDraftProposer` — the DFlash drafter, reached through
 *     the running `llama-server`'s `-md` drafter. GPU dispatch N=1 (no
 *     command-buffer batching for voice — ledger "Keep voice dispatch
 *     unbatched"); honours `cancel.cancelled` between kernel ticks.
 *   - `LlamaServerTargetVerifier` — the text model's autoregressive
 *     verify step against its own KV cache, also via `llama-server`. When
 *     the native fork emits exact verifier accept/reject ranges
 *     (`extractVerifierRejectRange` in `dflash-server.ts`), the verifier
 *     consumes them directly; until then it falls back to a plain
 *     autoregressive step that re-derives accept/reject by comparing the
 *     draft against the model's own next tokens.
 *
 * Hard-fail discipline (AGENTS.md §3 + §9): a missing fused ASR region in
 * voice mode is a thrown `VoiceStartupError`, never a silent cloud
 * fallback, never log-and-continue.
 *
 * Why a separate file from `pipeline.ts`: `pipeline.ts` stays
 * dependency-free (it is the streaming contract, importable by text-only
 * callers). The runtime wiring — FFI handles, the llama-server backend —
 * lives here so the contract module does not drag those in.
 */

import type { DflashGenerateArgs, DflashLlamaServer } from "../dflash-server";
import { VoiceStartupError } from "./errors";
import type {
  ElizaInferenceContextHandle,
  ElizaInferenceFfi,
} from "./ffi-bindings";
import type {
  AsrTokenStreamer,
  DraftProposer,
  TargetVerifier,
} from "./pipeline";
import type {
  PcmFrame,
  StreamingTranscriber,
  TextToken,
  TranscriptionAudio,
  VerifierStreamEvent,
} from "./types";

/* ------------------------------------------------------------------ */
/* AsrTokenStreamer                                                    */
/* ------------------------------------------------------------------ */

/**
 * Split a transcript string into contiguous text tokens. The fused ASR
 * tokenizer is shared with the text backbone (AGENTS.md §1 — zero
 * re-tokenization), so the pipeline only needs *contiguous* token
 * indices, not the model's exact subword boundaries; whitespace-aware
 * word chunking is the closest stable approximation when only surface
 * text is available. Empty input yields no tokens.
 *
 * `tokenIds`, when supplied, are the text-model vocabulary ids the fused
 * ASR decoder emitted for `transcript`. When the lengths line up they are
 * attached as `TextToken.id` so a downstream in-process handoff can skip
 * re-tokenization; otherwise (mismatch — the surface split disagrees with
 * the decoder's subword boundaries) the ids are dropped and only the
 * word-chunk approximation is returned.
 */
export function splitTranscriptToTokens(
  transcript: string,
  startIndex = 0,
  tokenIds?: ReadonlyArray<number>,
): TextToken[] {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return [];
  // Keep leading whitespace attached to each chunk after the first so a
  // join() round-trips to the original spacing (matches how the chunker
  // reconstructs phrase text from token.text concatenation).
  const parts = trimmed.split(/(?<=\S)(?=\s)/).filter((p) => p.length > 0);
  const tokens: TextToken[] = [];
  // Pass through real token ids only when the producer's id count matches
  // the surface-chunk count — anything else means the two disagree on
  // boundaries and a positional join would mislabel ids.
  const ids =
    tokenIds && tokenIds.length === parts.length ? tokenIds : undefined;
  let i = startIndex;
  for (let p = 0; p < parts.length; p++) {
    const token: TextToken = { index: i++, text: parts[p] };
    if (ids) token.id = ids[p];
    tokens.push(token);
  }
  return tokens;
}

/**
 * Real ASR backend for the overlapped `VoicePipeline`: adapts a live
 * frame-fed `StreamingTranscriber` (`voice/transcriber.ts` — the fused
 * `eliza_inference_asr_stream_*` decoder, or the whisper.cpp interim
 * adapter, or whatever `EngineVoiceBridge.createStreamingTranscriber`
 * resolved) onto the pipeline's batch `transcribeStream` token-iterator.
 *
 * The pipeline scaffold hands a whole utterance buffer; this adapter
 * feeds it as one frame, `flush()`es to finalize, and yields the final
 * transcript split into contiguous text tokens (one `await` between
 * tokens so a barge-in cancel lands before the next one). The transcriber
 * is disposed when the iterator ends or `cancel` trips. When `VadDetector`
 * (W1) is wired into the underlying `StreamingTranscriber`, decoding is
 * gated to active speech windows there — this layer is unchanged.
 */
export class StreamingTranscriberTokenStreamer implements AsrTokenStreamer {
  private readonly transcriber: StreamingTranscriber;

  constructor(transcriber: StreamingTranscriber) {
    this.transcriber = transcriber;
  }

  async *transcribeStream(
    audio: TranscriptionAudio,
    cancel: { cancelled: boolean },
  ): AsyncIterable<TextToken> {
    try {
      if (cancel.cancelled) return;
      const frame: PcmFrame = {
        pcm: audio.pcm,
        sampleRate: audio.sampleRate,
        timestampMs: 0,
      };
      this.transcriber.feed(frame);
      const final = await this.transcriber.flush();
      if (cancel.cancelled) return;
      // The fused Qwen3-ASR decoder shares the text vocab (AGENTS.md §1),
      // so when it reports token ids alongside the transcript they are
      // forwarded as `TextToken.id` — the whisper.cpp interim adapter
      // omits them (different tokenizer) and the word-chunk fallback is
      // used.
      for (const token of splitTranscriptToTokens(
        final.partial,
        0,
        final.tokens,
      )) {
        if (cancel.cancelled) return;
        yield token;
        await Promise.resolve();
      }
    } finally {
      this.transcriber.dispose();
    }
  }
}

/**
 * `AsrTokenStreamer` over the v1 batch ABI's ASR. Construction is cheap;
 * `transcribeStream` calls the synchronous FFI `asrTranscribe` once and
 * then yields the resulting tokens one at a time so downstream nodes (the
 * drafter/verifier kick-off) see the same finite token-stream shape they
 * would from a true streaming decoder.
 *
 * `getContext` is the lazily-created `ElizaInferenceContextHandle` the
 * bridge owns — passing it as a thunk keeps this adapter from forcing the
 * context allocation before voice is actually used.
 */
export class FfiAsrTokenStreamer implements AsrTokenStreamer {
  private readonly ffi: ElizaInferenceFfi;
  private readonly getContext: () => ElizaInferenceContextHandle;
  private readonly maxTextBytes: number;

  constructor(args: {
    ffi: ElizaInferenceFfi;
    getContext: () => ElizaInferenceContextHandle;
    maxTextBytes?: number;
  }) {
    this.ffi = args.ffi;
    this.getContext = args.getContext;
    this.maxTextBytes = args.maxTextBytes ?? 8192;
  }

  async *transcribeStream(
    audio: TranscriptionAudio,
    cancel: { cancelled: boolean },
  ): AsyncIterable<TextToken> {
    if (cancel.cancelled) return;
    const transcript = this.ffi.asrTranscribe({
      ctx: this.getContext(),
      pcm: audio.pcm,
      sampleRateHz: audio.sampleRate,
      maxTextBytes: this.maxTextBytes,
    });
    if (cancel.cancelled) return;
    for (const token of splitTranscriptToTokens(transcript)) {
      if (cancel.cancelled) return;
      yield token;
      // Yield to the event loop between tokens so a barge-in cancel that
      // arrives mid-stream lands before the next token is emitted.
      await Promise.resolve();
    }
  }
}

/**
 * `AsrTokenStreamer` that hard-fails: used when no ASR backend is
 * available (no fused streaming decoder, no whisper.cpp binary/model, no
 * bundled ASR region) but a voice turn was requested. AGENTS.md §3 —
 * missing required voice backend in voice mode is a thrown
 * `VoiceStartupError`, never a silent fallback.
 */
export class MissingAsrTranscriber implements AsrTokenStreamer {
  constructor(private readonly reason: string) {}
  // biome-ignore lint/correctness/useYield: intentionally throws before yielding
  async *transcribeStream(): AsyncIterable<TextToken> {
    throw new VoiceStartupError("missing-fused-build", this.reason);
  }
}

/* ------------------------------------------------------------------ */
/* llama-server draft / verify                                        */
/* ------------------------------------------------------------------ */

/**
 * Minimal surface of the running DFlash llama-server the draft/verify
 * adapters need. Kept structural so tests can pass a fake without
 * standing up a real server. `generateWithVerifierEvents` runs one
 * streamed completion and reports verifier-shaped accept/reject events
 * (synthesized from OpenAI deltas today, exact ranges once the native
 * fork emits them — `extractVerifierRejectRange`).
 */
export interface DflashTextRunner {
  /** True only when a llama-server with a configured `-md` drafter is up. */
  hasDrafter(): boolean;
  generateWithVerifierEvents(
    args: DflashGenerateArgs & {
      onVerifierEvent: (event: VerifierStreamEvent) => void | Promise<void>;
    },
  ): Promise<{ text: string }>;
}

/** Adapt the concrete `DflashLlamaServer` onto `DflashTextRunner`. */
export function dflashTextRunner(server: DflashLlamaServer): DflashTextRunner {
  return {
    hasDrafter() {
      return server.loadedDrafterModelPath() !== null;
    },
    async generateWithVerifierEvents(args) {
      const { text } = await server.generateWithUsage(args);
      return { text };
    },
  };
}

/**
 * Build the prompt string the drafter/verifier run against from the
 * accepted prefix. The pipeline holds tokens, not a chat transcript; for
 * the streaming verify loop we feed back the concatenated token text as a
 * raw continuation prompt (`cache_prompt` on the server reuses the prefix
 * KV between rounds so this is cheap to re-send).
 */
function prefixToPrompt(prefix: ReadonlyArray<TextToken>): string {
  return prefix.map((t) => t.text).join("");
}

/**
 * `DraftProposer` over the DFlash drafter via llama-server. The fork's
 * `--draft-max` already bounds proposals; this adapter additionally
 * clamps to the pipeline's `maxDraft` and stops early on
 * `cancel.cancelled`. GPU dispatch is N=1 (the fork's voice profile
 * disables command-buffer batching — ledger §2 "Keep voice dispatch
 * unbatched") so a barge-in lands at the next kernel boundary.
 *
 * Until the fork exposes a "draft only, return the proposed tokens"
 * endpoint, the proposer issues a short low-temperature completion
 * (`maxTokens = maxDraft`) and treats the produced tokens as the draft
 * window. The verifier then re-checks them against the target's KV — the
 * standard speculative-decoding contract, just with the draft sourced
 * from the same server.
 */
export class LlamaServerDraftProposer implements DraftProposer {
  private readonly runner: DflashTextRunner;

  constructor(runner: DflashTextRunner) {
    this.runner = runner;
  }

  async propose(args: {
    prefix: ReadonlyArray<TextToken>;
    maxDraft: number;
    cancel: { cancelled: boolean };
  }): Promise<TextToken[]> {
    if (args.cancel.cancelled) return [];
    if (!this.runner.hasDrafter()) {
      // No drafter wired ⇒ no speculation this round. The verifier still
      // produces one token per round (plain AR step), so generation
      // continues; DFlash being mandatory is enforced at server-launch
      // time, not here.
      return [];
    }
    const accepted: TextToken[] = [];
    let nextIndex =
      args.prefix.length > 0
        ? args.prefix[args.prefix.length - 1].index + 1
        : 0;
    await this.runner.generateWithVerifierEvents({
      prompt: prefixToPrompt(args.prefix),
      maxTokens: Math.max(1, Math.floor(args.maxDraft)),
      temperature: 0,
      signal: cancelToSignal(args.cancel),
      onVerifierEvent: (event) => {
        if (event.kind !== "accept") return;
        for (const tok of event.tokens) {
          if (accepted.length >= args.maxDraft) break;
          accepted.push({ index: nextIndex++, text: tok.text });
        }
      },
    });
    if (args.cancel.cancelled) return [];
    return accepted.slice(0, Math.max(1, Math.floor(args.maxDraft)));
  }
}

/**
 * `TargetVerifier` over the text model via llama-server. Runs one
 * autoregressive verify step against the server's KV cache: it sends the
 * accepted prefix and reads back the model's own continuation. The
 * leading tokens that match the supplied `draft` are "accepted from
 * draft"; the first mismatch is the correction; the model's `done` /
 * stop is propagated.
 *
 * When the native fork emits exact verifier reject ranges, the
 * `onVerifierEvent` callback already carries `kind: "reject"` events with
 * the rejected token positions — this adapter records both and trusts the
 * server's accept/reject split rather than re-deriving it.
 */
export class LlamaServerTargetVerifier implements TargetVerifier {
  private readonly runner: DflashTextRunner;
  private readonly maxStep: number;

  constructor(runner: DflashTextRunner, opts: { maxStep?: number } = {}) {
    this.runner = runner;
    this.maxStep = Math.max(1, Math.floor(opts.maxStep ?? 16));
  }

  async verify(args: {
    prefix: ReadonlyArray<TextToken>;
    draft: ReadonlyArray<TextToken>;
    cancel: { cancelled: boolean };
  }): Promise<{ accepted: TextToken[]; done: boolean }> {
    if (args.cancel.cancelled) return { accepted: [], done: false };
    // Step budget: enough to confirm the whole draft window plus one
    // correction token (and a little headroom for the model's own bonus
    // tokens past a fully-accepted draft).
    const stepTokens = Math.min(
      this.maxStep,
      Math.max(1, args.draft.length + 1),
    );
    let nextIndex =
      args.prefix.length > 0
        ? args.prefix[args.prefix.length - 1].index + 1
        : 0;
    const produced: TextToken[] = [];
    let done = false;
    const { text } = await this.runner.generateWithVerifierEvents({
      prompt: prefixToPrompt(args.prefix),
      maxTokens: stepTokens,
      temperature: 0,
      signal: cancelToSignal(args.cancel),
      onVerifierEvent: (event) => {
        if (event.kind === "accept") {
          for (const tok of event.tokens) {
            produced.push({ index: nextIndex++, text: tok.text });
          }
        }
        // reject events: the server already retracted those positions
        // from its own stream, so we just don't append them. Nothing else
        // to do here — the chunker rollback is driven by the pipeline
        // comparing `accepted` against `draft`.
      },
    });
    if (args.cancel.cancelled) return { accepted: [], done: false };
    if (produced.length === 0 && text.length > 0) {
      // Non-streaming server (no per-delta events): fall back to splitting
      // the returned text into tokens.
      produced.push(...splitTranscriptToTokens(text, nextIndex));
    }
    // The model reached its natural stop when it produced fewer tokens
    // than the step budget (it hit an EOS / stop sequence before the cap).
    done = produced.length < stepTokens;
    return { accepted: produced, done };
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bridge a `{cancelled: boolean}` flag (the pipeline's cancellation
 * primitive — checked between kernel ticks) onto an `AbortSignal` so the
 * llama-server HTTP request aborts when a barge-in fires. Polls at a
 * coarse interval; the pipeline's own `cancel.cancelled` checks at
 * scheduler-tick boundaries are the fine-grained path, this just makes
 * sure an in-flight HTTP body doesn't keep streaming after a barge-in.
 */
function cancelToSignal(cancel: { cancelled: boolean }): AbortSignal {
  const controller = new AbortController();
  if (cancel.cancelled) {
    controller.abort();
    return controller.signal;
  }
  const timer = setInterval(() => {
    if (cancel.cancelled) {
      controller.abort();
      clearInterval(timer);
    }
  }, 10);
  // Don't keep the event loop alive purely for this poll.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
  controller.signal.addEventListener("abort", () => clearInterval(timer), {
    once: true,
  });
  return controller.signal;
}
