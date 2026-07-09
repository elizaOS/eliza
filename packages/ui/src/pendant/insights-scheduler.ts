/**
 * Pendant insights — the cadence + dedupe scheduler (privacy/cost core).
 *
 * The pendant streams finalized transcript utterances (see
 * {@link import("./pendant-connection.js").PendantConnection}). This scheduler
 * accumulates them and periodically asks an {@link
 * import("./insights-client.js").InsightsClient} for a structured rollup — under
 * strict privacy + cost controls:
 *
 *  1. OPT-IN: no segment is retained and no request is made unless `enabled`.
 *     Flipping `setEnabled(false)` clears the buffer AND aborts any in-flight
 *     request — a hard stop, not a pause-with-retained-state.
 *  2. NEVER WHILE PAUSED: `setPaused(true)` (e.g. the pendant's push-to-mute /
 *     ambient gate closed) stops both ingestion AND generation. Nothing is
 *     uploaded while paused.
 *  3. ROLLING WINDOW: only the most recent `maxWindowSegments` are kept; older
 *     segments age out so the buffer (and each prompt) is bounded.
 *  4. DEDUPE HASH: an utterance whose normalized-text hash matches a recent one
 *     is dropped (ASR repeats / echo), so we don't pay to summarize the same line.
 *  5. MIN THRESHOLD: generation only fires once at least `minSegments` NEW
 *     segments have accumulated since the last successful rollup.
 *  6. MAX CADENCE: at most one generation per `minIntervalMs`, regardless of how
 *     fast utterances arrive — a hard rate limit on model spend.
 *  7. CANCELLATION: `dispose()` / disconnect aborts the in-flight request; a
 *     result that lands after disposal is discarded.
 *  8. NO SILENT REDACTION + NO FAKE INSIGHTS: the scheduler never mutates segment
 *     text, and it surfaces empty rollups as-is (it does not synthesize content).
 */

import {
  fnv1a32,
  MAX_INSIGHT_SEGMENTS_PER_REQUEST,
  MIN_INSIGHT_SEGMENTS,
  makePendantSegmentId,
  type PendantInsightSegmentInput,
  type PendantInsights,
} from "@elizaos/shared";
import type { InsightsClient, InsightsClientResult } from "./insights-client";

export interface InsightsSchedulerOptions {
  client: InsightsClient;
  /** Called with each newly generated rollup. */
  onInsights: (insights: PendantInsights) => void;
  /** Called on a genuine generation error (not a skip/cancel). Optional. */
  onError?: (message: string) => void;
  /** Stable id for this listening session (drives deterministic segment ids). */
  sessionId?: string;
  /** New segments required since last rollup before generating. Default 6. */
  minSegments?: number;
  /** Minimum ms between generations (hard cost cap). Default 90_000 (90s). */
  minIntervalMs?: number;
  /** Rolling window cap on retained segments. Default 200. */
  maxWindowSegments?: number;
  /** How many recent hashes to remember for dedupe. Default 64. */
  dedupeHistory?: number;
  /** Transcript char budget forwarded to the server. Optional. */
  maxTranscriptChars?: number;
  /** Clock injector (tests). Defaults to Date.now. */
  now?: () => number;
}

interface InternalSegment extends PendantInsightSegmentInput {
  hash: string;
}

/** A rolling ambient-insight scheduler. Construct one per listening session. */
export class PendantInsightsScheduler {
  private enabled = false;
  private paused = false;
  private disposed = false;

  private readonly sessionId: string;
  private ordinal = 0;
  private readonly window: InternalSegment[] = [];
  /** Segments added since the last SUCCESSFUL generation (the min-threshold gate). */
  private newSinceLastRun = 0;
  /** Time the most recent request STARTED, successful or not (hard rate cap). */
  private lastAttemptAt: number | null = null;
  private lastSummary = "";
  private cadenceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Recent normalized-text hashes for dedupe (FIFO, capped). */
  private readonly recentHashes: string[] = [];
  private readonly recentHashSet = new Set<string>();

  private inFlight: AbortController | null = null;
  private generating = false;

  private readonly minSegments: number;
  private readonly minIntervalMs: number;
  private readonly maxWindowSegments: number;
  private readonly dedupeHistory: number;
  private readonly now: () => number;

  constructor(private readonly opts: InsightsSchedulerOptions) {
    this.sessionId =
      opts.sessionId ?? `s${Math.floor((opts.now ?? Date.now)())}`;
    this.minSegments = Math.min(
      MAX_INSIGHT_SEGMENTS_PER_REQUEST,
      Math.max(MIN_INSIGHT_SEGMENTS, opts.minSegments ?? 6),
    );
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 90_000);
    this.maxWindowSegments = Math.min(
      MAX_INSIGHT_SEGMENTS_PER_REQUEST,
      Math.max(this.minSegments, opts.maxWindowSegments ?? 200),
    );
    this.dedupeHistory = Math.max(1, opts.dedupeHistory ?? 64);
    this.now = opts.now ?? Date.now;
  }

  /** Opt-in toggle. Turning OFF clears all retained state + aborts in-flight. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Pause/resume ingestion + generation (mute gate). Paused NEVER uploads. Unlike
   * disable, pause RETAINS the accumulated window so resuming continues the
   * rolling context — but any in-flight request is aborted on pause.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.clearCadenceTimer();
      this.abortInFlight("paused");
    } else {
      void this.maybeGenerate();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Feed one finalized utterance. No-op unless enabled + not paused + not
   * disposed. Applies dedupe + rolling-window trimming, then evaluates whether a
   * generation should fire. Returns the segment id if ingested, else null.
   */
  addUtterance(
    text: string,
    atMs?: number,
    speakerLabel?: string,
  ): string | null {
    if (!this.enabled || this.paused || this.disposed) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    const hash = fnv1a32(normalizeForDedupe(trimmed));
    if (this.recentHashSet.has(hash)) return null; // dedupe: drop repeat

    const id = makePendantSegmentId(this.sessionId, this.ordinal, trimmed);
    const seg: InternalSegment = {
      id,
      ordinal: this.ordinal,
      text: trimmed,
      hash,
      ...(speakerLabel ? { speakerLabel } : {}),
      ...(atMs ? { atMs } : {}),
    };
    this.ordinal++;
    this.window.push(seg);
    this.newSinceLastRun++;
    this.rememberHash(hash);
    this.trimWindow();

    void this.maybeGenerate();
    return id;
  }

  /** Snapshot the current retained window (defensive copy) for inspection/UI. */
  getWindow(): PendantInsightSegmentInput[] {
    return this.window.map(({ hash: _hash, ...rest }) => ({ ...rest }));
  }

  /** True while a generation request is in flight. */
  isGenerating(): boolean {
    return this.generating;
  }

  /**
   * Force a generation attempt now, bypassing the cadence timer but NOT the
   * privacy gates or the min-segment threshold. Useful on a manual "summarize
   * now" affordance. Resolves when the attempt settles.
   */
  async flush(): Promise<void> {
    await this.maybeGenerate(true);
  }

  /** Tear down: abort in-flight, clear state, block further work. */
  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private reset(): void {
    this.abortInFlight("reset");
    this.window.length = 0;
    this.recentHashes.length = 0;
    this.recentHashSet.clear();
    this.newSinceLastRun = 0;
    this.lastAttemptAt = null;
    this.lastSummary = "";
    this.clearCadenceTimer();
    // Keep `ordinal` monotonic so re-enabling in the same session never reuses ids.
  }

  private abortInFlight(reason: string): void {
    if (this.inFlight) {
      this.inFlight.abort(reason);
      this.inFlight = null;
    }
    this.generating = false;
  }

  private rememberHash(hash: string): void {
    this.recentHashes.push(hash);
    this.recentHashSet.add(hash);
    while (this.recentHashes.length > this.dedupeHistory) {
      const evicted = this.recentHashes.shift();
      if (evicted !== undefined) this.recentHashSet.delete(evicted);
    }
  }

  private trimWindow(): void {
    while (this.window.length > this.maxWindowSegments) this.window.shift();
  }

  private clearCadenceTimer(): void {
    if (this.cadenceTimer !== null) {
      clearTimeout(this.cadenceTimer);
      this.cadenceTimer = null;
    }
  }

  private scheduleAfterCadence(delayMs: number): void {
    if (
      this.cadenceTimer !== null ||
      this.disposed ||
      !this.enabled ||
      this.paused
    ) {
      return;
    }
    this.cadenceTimer = setTimeout(
      () => {
        this.cadenceTimer = null;
        void this.maybeGenerate();
      },
      Math.max(0, delayMs),
    );
  }

  /** Gate + fire a generation. `force` skips only the cadence timer. */
  private async maybeGenerate(force = false): Promise<void> {
    if (this.disposed || !this.enabled || this.paused) return;
    if (this.generating) return; // one at a time
    if (this.newSinceLastRun < this.minSegments) return;
    const nowMs = this.now();
    if (
      !force &&
      this.lastAttemptAt !== null &&
      nowMs - this.lastAttemptAt < this.minIntervalMs
    ) {
      this.scheduleAfterCadence(
        this.minIntervalMs - (nowMs - this.lastAttemptAt),
      );
      return;
    }
    if (this.window.length === 0) return;

    this.clearCadenceTimer();
    const controller = new AbortController();
    this.inFlight = controller;
    this.generating = true;
    this.lastAttemptAt = nowMs;

    const segments = this.getWindow();
    const newCountAtStart = this.newSinceLastRun;
    const priorSummary = this.lastSummary || undefined;

    let result: InsightsClientResult;
    try {
      result = await this.opts.client.requestInsights({
        segments,
        ...(priorSummary ? { priorSummary } : {}),
        ...(this.opts.maxTranscriptChars
          ? { maxTranscriptChars: this.opts.maxTranscriptChars }
          : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // Client threw (should be rare — it normalizes errors). Treat as error
      // unless we were aborted.
      this.finishGeneration(controller);
      if (!controller.signal.aborted && !this.disposed) {
        this.opts.onError?.(err instanceof Error ? err.message : String(err));
        if (this.newSinceLastRun >= this.minSegments) {
          this.scheduleAfterCadence(this.minIntervalMs);
        }
      }
      return;
    }

    // A result that landed after disposal / disable / pause / a new abort is
    // discarded — cancellation on disconnect.
    if (
      this.disposed ||
      controller.signal.aborted ||
      this.inFlight !== controller
    ) {
      this.finishGeneration(controller);
      return;
    }
    this.finishGeneration(controller);

    if (result.ok) {
      // Preserve utterances that arrived while this request was in flight.
      this.newSinceLastRun = Math.max(
        0,
        this.newSinceLastRun - newCountAtStart,
      );
      if (result.insights.summary) this.lastSummary = result.insights.summary;
      this.opts.onInsights(result.insights);
    } else if (!result.skipped) {
      this.opts.onError?.(result.error);
    }

    // If enough new speech arrived during the request, guarantee a later pass
    // even when no additional utterance arrives to trigger maybeGenerate.
    if (this.newSinceLastRun >= this.minSegments) {
      const elapsed = this.now() - (this.lastAttemptAt ?? this.now());
      this.scheduleAfterCadence(this.minIntervalMs - elapsed);
    }
  }

  private finishGeneration(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.generating = false;
    }
  }
}

/**
 * Normalize an utterance for dedupe: lowercase, collapse whitespace, strip
 * trailing punctuation. So "Hello there." and "hello  there" dedupe to the same
 * hash. Does NOT mutate the stored text — dedupe is hash-only (no silent redaction).
 */
export function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}
