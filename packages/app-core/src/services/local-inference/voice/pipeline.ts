/**
 * Pipelined parallel-generation scheduler — the fused mic→speech graph
 * from `packages/inference/AGENTS.md` §4:
 *
 *   mic / file → ASR → text tokens
 *                      ↓
 *                    scheduler ──→ DFlash drafter (proposes N tokens)
 *                                         ∥  (overlap, not sequential)
 *                                  target verifier (text model)
 *                                         ↓
 *                                accepted tokens → phrase chunker
 *                                         ↓                  ↘
 *                              speaker preset (cached)    rollback queue
 *                                         ↓                  ↙
 *                                    OmniVoice TTS ←── on-reject: cancel chunk
 *                                         ↓
 *                                    PCM ring buffer → audio out
 *
 * The headline contract: **the moment ASR emits its last token, the
 * DFlash drafter starts drafting AND the target starts verifying — they
 * overlap.** Drafter speculation N tokens ahead happens concurrently
 * with the target verifying the previous window; accepted tokens are
 * handed to the phrase chunker within the same scheduler tick.
 *
 * GPU command buffers stay N=1 (no command-buffer batching for voice)
 * so a barge-in cancel lands at the next kernel boundary, not after a
 * batch flush.
 *
 * Why this lives next to `VoiceScheduler` and not inside it: the
 * scheduler owns the *audio* side (chunker → TTS → ring buffer →
 * rollback → barge-in). This module owns the *text-generation* side
 * (audio source → ASR → drafter∥verifier loop) and feeds accepted /
 * rejected ranges into the scheduler. Keeping them separate keeps the
 * scheduler usable from text-only callers (which reach the same nodes
 * via the same scheduler — AGENTS.md §4) without an ASR/drafter
 * dependency.
 */

import type { VoiceScheduler } from "./scheduler";
import type {
  PcmFrame,
  RejectedTokenRange,
  StreamingTranscriber,
  TextToken,
  TranscriptionAudio,
  VerifierStreamEvent,
} from "./types";

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
 * DFlash drafter. `propose` returns up to `maxDraft` candidate
 * continuation tokens given the accepted prefix. N=1 command buffers —
 * the implementation MUST keep its GPU dispatch short enough to cancel
 * at the next kernel boundary (no command-buffer batching for voice).
 * Honours `cancel.cancelled` between kernel ticks.
 */
export interface DraftProposer {
  propose(args: {
    prefix: ReadonlyArray<TextToken>;
    maxDraft: number;
    cancel: { cancelled: boolean };
  }): Promise<TextToken[]>;
}

/**
 * Target verifier (the text model). Given the accepted prefix plus a
 * draft window, returns which leading draft tokens are accepted and the
 * one corrected token at the first divergence (if any). When the draft
 * is empty, the verifier still produces one token (plain autoregressive
 * step). Honours `cancel.cancelled` between kernel ticks.
 */
export interface TargetVerifier {
  verify(args: {
    prefix: ReadonlyArray<TextToken>;
    draft: ReadonlyArray<TextToken>;
    cancel: { cancelled: boolean };
  }): Promise<{
    accepted: TextToken[];
    /** Set when the verifier reached the natural end of generation. */
    done: boolean;
  }>;
}

export interface VoicePipelineDeps {
  scheduler: VoiceScheduler;
  /**
   * The live frame-fed ASR adapter (`voice/transcriber.ts` — fused
   * `eliza_inference_asr_stream_*`, the whisper.cpp interim adapter, or
   * `MissingAsrTranscriber` deferring a hard failure). The pipeline drives
   * it as a batch: it feeds the whole (VAD-gated) utterance buffer as one
   * frame, `flush()`es to finalize, then splits the final transcript into
   * contiguous text tokens (`splitTranscriptToTokens`). One `StreamingTranscriber`
   * contract — there is no separate batch ASR interface.
   */
  transcriber: StreamingTranscriber;
  drafter: DraftProposer;
  verifier: TargetVerifier;
}

export interface VoicePipelineConfig {
  /**
   * Max tokens DFlash drafts per round. Per-tier; small (≤8) so a
   * rollback is cheap. The drafter and verifier overlap one round: while
   * the verifier checks round k, the drafter speculates round k+1.
   */
  maxDraftTokens: number;
  /**
   * Hard cap on generated tokens per turn (safety stop). The verifier's
   * `done` flag is the normal stop; this bounds a runaway model.
   */
  maxGeneratedTokens?: number;
}

export interface VoicePipelineEvents {
  /** Fired once, the instant ASR emits its final token (= drafter+verifier kick-off). */
  onAsrComplete?(tokens: ReadonlyArray<TextToken>): void;
  /** Fired with each verifier accept/reject event before it hits the scheduler. */
  onVerifierEvent?(event: VerifierStreamEvent): void;
  /** Fired when the loop exits (verifier `done`, token cap, or barge-in cancel). */
  onComplete?(reason: "done" | "token-cap" | "cancelled"): void;
}

const DEFAULT_MAX_GENERATED_TOKENS = 4096;

interface PipelineRun {
  cancel: { cancelled: boolean };
  done: Promise<"done" | "token-cap" | "cancelled">;
}

/**
 * One pipeline per active voice turn. Construct, call `run(audio)`,
 * await the returned promise (or call `cancel()` for barge-in). The
 * scheduler's barge-in controller also cancels an in-flight run — wire
 * `bridge.triggerBargeIn()` and this run's `cancel()` to the same VAD
 * signal so both the audio side (ring buffer drain) and the text side
 * (stop drafting/verifying) abort together.
 */
export class VoicePipeline {
  private readonly scheduler: VoiceScheduler;
  private readonly transcriber: StreamingTranscriber;
  private readonly drafter: DraftProposer;
  private readonly verifier: TargetVerifier;
  private readonly maxDraftTokens: number;
  private readonly maxGeneratedTokens: number;
  private readonly events: VoicePipelineEvents;
  private active: PipelineRun | null = null;

  constructor(
    deps: VoicePipelineDeps,
    config: VoicePipelineConfig,
    events: VoicePipelineEvents = {},
  ) {
    this.scheduler = deps.scheduler;
    this.transcriber = deps.transcriber;
    this.drafter = deps.drafter;
    this.verifier = deps.verifier;
    this.maxDraftTokens = Math.max(1, Math.floor(config.maxDraftTokens));
    this.maxGeneratedTokens = Math.max(
      1,
      Math.floor(config.maxGeneratedTokens ?? DEFAULT_MAX_GENERATED_TOKENS),
    );
    this.events = events;
    // A mic VAD barge-in cancels the audio side via the scheduler's
    // barge-in controller; mirror it onto the text side so we stop
    // drafting/verifying at the next kernel boundary too.
    this.scheduler.bargeIn.attach({
      onCancel: () => {
        if (this.active) this.active.cancel.cancelled = true;
      },
    });
  }

  /** True while a turn is in flight. */
  isRunning(): boolean {
    return this.active !== null;
  }

  /**
   * Run one mic→speech turn. ASR streams first; the instant its last
   * token lands, the drafter and verifier kick off concurrently and
   * accepted tokens flow into the scheduler's chunker on the same tick.
   * Resolves with the exit reason. Throws if a turn is already running.
   */
  async run(
    audio: TranscriptionAudio,
  ): Promise<"done" | "token-cap" | "cancelled"> {
    if (this.active) {
      throw new Error(
        "[voice-pipeline] a turn is already running; cancel() it or await the previous run() first",
      );
    }
    const cancel = { cancelled: false };
    const done = this.execute(audio, cancel);
    this.active = { cancel, done };
    try {
      return await done;
    } finally {
      this.active = null;
    }
  }

  /**
   * Barge-in: cancel the in-flight turn. Stops ASR, stops the
   * drafter/verifier loop at the next kernel boundary, and triggers the
   * scheduler's barge-in (ring buffer drain + chunker flush + in-flight
   * TTS cancel). No-op when no turn is running.
   */
  cancel(): void {
    if (this.active) this.active.cancel.cancelled = true;
    this.scheduler.bargeIn.onMicActive();
  }

  private async execute(
    audio: TranscriptionAudio,
    cancel: { cancelled: boolean },
  ): Promise<"done" | "token-cap" | "cancelled"> {
    // --- ASR phase -----------------------------------------------------
    // Drive the live `StreamingTranscriber` as a batch: feed the whole
    // (already VAD-gated) utterance buffer as one frame, `flush()` to
    // force-finalize, and split the final transcript into contiguous text
    // tokens. The fused Qwen3-ASR decoder shares the text vocab (AGENTS.md
    // §1), so when it reports token ids alongside the transcript they ride
    // along as `TextToken.id` — the whisper.cpp interim adapter omits them
    // (different tokenizer) and the word-chunk fallback is used.
    const asrTokens = await this.transcribeAll(audio, cancel);
    if (cancel.cancelled) return this.finish("cancelled");
    // The instant ASR's last token has been emitted: drafter + verifier
    // start. (`onAsrComplete` is the kick-off observability hook.)
    this.events.onAsrComplete?.(asrTokens);

    // --- overlapped drafter ∥ verifier loop ---------------------------
    // Each round:
    //   1. take the drafter's N proposed tokens (the previous round's
    //      `propose` ran concurrently with the previous verify),
    //   2. SPECULATIVELY push them to the phrase chunker now — TTS for
    //      drafted phrases starts immediately (low first-audio latency),
    //   3. concurrently: kick the *next* draft AND run the verifier,
    //   4. when the verifier returns, drop the not-yet-spoken TTS chunks
    //      for any draft positions it rejected (rollback queue), then
    //      push the verifier's corrected token,
    //   5. if a reject happened, the next draft we kicked is stale — drop
    //      it and re-draft from the corrected prefix.
    // The drafter and verifier passes for a round overlap; that is the
    // whole point ("the moment ASR emits its last token the DFlash
    // drafter starts drafting AND the target starts verifying").
    const prefix: TextToken[] = [...asrTokens];
    let nextIndex =
      asrTokens.length > 0 ? asrTokens[asrTokens.length - 1].index + 1 : 0;
    let generated = 0;

    let pendingDraft = this.drafter.propose({
      prefix,
      maxDraft: this.maxDraftTokens,
      cancel,
    });

    for (;;) {
      if (cancel.cancelled) return this.finish("cancelled");
      const draft = await pendingDraft;
      if (cancel.cancelled) return this.finish("cancelled");
      const indexedDraft = draft.map((t, i) => ({
        index: nextIndex + i,
        text: t.text,
      }));

      // (2) speculative TTS — push drafted tokens to the chunker now.
      let speculated = 0;
      for (const t of indexedDraft) {
        if (generated + speculated >= this.maxGeneratedTokens) break;
        await this.scheduler.accept(t);
        speculated++;
      }
      if (speculated > 0) {
        this.events.onVerifierEvent?.({
          kind: "accept",
          tokens: indexedDraft.slice(0, speculated),
        });
      }

      // (3) OVERLAP: kick next draft on the optimistic prefix, then verify.
      const optimisticPrefix = [...prefix, ...indexedDraft];
      let nextDraft: Promise<TextToken[]> | null = this.drafter.propose({
        prefix: optimisticPrefix,
        maxDraft: this.maxDraftTokens,
        cancel,
      });
      const result = await this.verifier.verify({
        prefix,
        draft: indexedDraft,
        cancel,
      });
      if (cancel.cancelled) return this.finish("cancelled");

      // (4) how many leading draft tokens did the verifier keep?
      const acceptedFromDraft = countMatchingPrefix(
        result.accepted,
        indexedDraft,
      );
      if (acceptedFromDraft < indexedDraft.length) {
        // Rejected draft tail → drop the matching not-yet-spoken TTS chunks.
        const range: RejectedTokenRange = {
          fromIndex: nextIndex + acceptedFromDraft,
          toIndex: nextIndex + indexedDraft.length - 1,
        };
        this.events.onVerifierEvent?.({
          kind: "reject",
          tokens: indexedDraft.slice(acceptedFromDraft),
        });
        await this.scheduler.reject(range);
        nextDraft = null; // (5) stale — re-draft from the corrected prefix
      }

      // Commit the accepted prefix to our running state, then push the
      // verifier's correction / bonus tokens (everything past the draft
      // tokens it kept) to the chunker on this same tick.
      for (let i = 0; i < acceptedFromDraft; i++) {
        prefix.push(indexedDraft[i]);
        generated++;
      }
      nextIndex += acceptedFromDraft;

      const extra = result.accepted.slice(acceptedFromDraft);
      const extraIndexed = extra.map((t, i) => ({
        index: nextIndex + i,
        text: t.text,
      }));
      if (extraIndexed.length > 0) {
        this.events.onVerifierEvent?.({ kind: "accept", tokens: extraIndexed });
        for (const t of extraIndexed) {
          if (generated >= this.maxGeneratedTokens) break;
          await this.scheduler.accept(t);
          prefix.push(t);
          nextIndex = t.index + 1;
          generated++;
        }
      }

      if (result.done) {
        await this.scheduler.flushPending();
        return this.finish("done");
      }
      if (generated >= this.maxGeneratedTokens) {
        await this.scheduler.flushPending();
        return this.finish("token-cap");
      }
      if (cancel.cancelled) return this.finish("cancelled");

      pendingDraft =
        nextDraft ??
        this.drafter.propose({
          prefix,
          maxDraft: this.maxDraftTokens,
          cancel,
        });
    }
  }

  /**
   * Feed the whole utterance buffer to the live transcriber, finalize,
   * and return the final transcript as contiguous text tokens. The
   * transcriber is disposed afterwards (it is one per turn). A barge-in
   * cancel checked before `flush()` short-circuits to an empty list.
   */
  private async transcribeAll(
    audio: TranscriptionAudio,
    cancel: { cancelled: boolean },
  ): Promise<TextToken[]> {
    try {
      if (cancel.cancelled) return [];
      const frame: PcmFrame = {
        pcm: audio.pcm,
        sampleRate: audio.sampleRate,
        timestampMs: 0,
      };
      this.transcriber.feed(frame);
      const final = await this.transcriber.flush();
      if (cancel.cancelled) return [];
      return splitTranscriptToTokens(final.partial, 0, final.tokens);
    } finally {
      this.transcriber.dispose();
    }
  }

  private finish(
    reason: "done" | "token-cap" | "cancelled",
  ): "done" | "token-cap" | "cancelled" {
    this.events.onComplete?.(reason);
    return reason;
  }
}

/**
 * How many leading tokens of `accepted` match `draft` by text. The
 * verifier accepts a prefix of the draft then emits a correction; this
 * counts the accepted-from-draft prefix length so the rest of the draft
 * (the rejected tail) can be rolled back from the TTS chunker.
 */
function countMatchingPrefix(
  accepted: ReadonlyArray<TextToken>,
  draft: ReadonlyArray<TextToken>,
): number {
  const n = Math.min(accepted.length, draft.length);
  let i = 0;
  while (i < n && accepted[i].text === draft[i].text) i++;
  return i;
}
