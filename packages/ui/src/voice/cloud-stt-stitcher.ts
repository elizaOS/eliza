/**
 * Client-side incremental-transcript stitcher for chunked-segment cloud STT
 * (voice V2a — Phase 1 streaming ASR, per VOICE-STREAMING-DESIGN §2.5).
 *
 * The cloud `/voice/stt` upstream is a BATCH file endpoint (multipart WAV →
 * `{transcript}`); there is no shared decoder state across requests. V2a's
 * "streaming" is therefore N independent per-segment transcriptions, POSTed as
 * the user speaks, stitched here into one monotonically-growing running
 * transcript that the composer renders live — instead of a single dead wait for
 * the whole utterance at stop().
 *
 * Because each segment is transcribed in isolation, the seams between segments
 * carry two artifacts this stitcher must absorb:
 *
 *   1. **Overlap duplication.** The capturer sends a short (~200ms) audio
 *      overlap between consecutive segments (so a word straddling a boundary is
 *      never bisected mid-phoneme). The transcriber then emits the overlapped
 *      words in BOTH segments — "…turn on the" / "the kitchen light". A naive
 *      concat yields "turn on the the kitchen light". The stitcher trims the
 *      duplicated seam by finding the longest word-suffix of the running text
 *      that is a word-prefix of the incoming segment.
 *
 *   2. **Out-of-order / duplicate delivery.** Segments are POSTed as they're
 *      captured but transcribed concurrently, so segment `seq=3` can resolve
 *      before `seq=2`. The stitcher is fed by `seq` and buffers a segment whose
 *      predecessor hasn't landed yet, flushing the contiguous run once the gap
 *      fills. A re-delivered `seq` (retry that both eventually succeed) is
 *      idempotent — the second delivery for an already-applied `seq` is ignored.
 *
 * This is deliberately NOT `LocalAgreementBuffer` / `PartialStabilizer` from
 * plugin-local-inference: those stabilize a SINGLE decoder's per-frame
 * hypotheses (same utterance, retracting tail words). Here each segment is a
 * finalized independent transcript — there is nothing to "agree" across frames;
 * the problem is seam dedup + ordering, which is what this solves. The seam
 * word-prefix-agreement borrows the same *idea* (prefer the longest agreeing
 * boundary) applied to segment seams rather than frame hypotheses.
 */

/** A single transcribed segment handed to the stitcher. */
export interface CloudSttSegment {
  /**
   * Monotonic 0-based sequence index assigned at capture time. Delivery may be
   * out of order; the stitcher reassembles by `seq`.
   */
  seq: number;
  /** The transcript text for this segment (already trimmed upstream). */
  text: string;
  /**
   * `true` for the terminal segment (the post-speech-end tail). After the final
   * segment's contiguous run is applied, {@link CloudSttSessionStitcher.isDone}
   * reads true and {@link CloudSttSessionStitcher.running} is the whole
   * utterance.
   */
  isFinal: boolean;
}

/** Split text into whitespace-delimited word tokens (empty in → empty out). */
function toWords(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

/** Case/punctuation-insensitive word key for seam matching. */
function wordKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Given the committed running words and an incoming segment's words, find how
 * many leading words of the incoming segment duplicate the trailing words of
 * the running text (the overlapped seam). Returns the count of incoming words
 * to DROP before appending.
 *
 * Scans candidate overlap lengths from longest→shortest (bounded by a small
 * window, since the audio overlap is ~200ms ≈ at most a few words) and picks
 * the longest suffix/prefix match. Matching is on normalized word keys so
 * "the," vs "the" and case differences at the seam still dedup.
 */
export function seamOverlapWordCount(
  runningWords: readonly string[],
  incomingWords: readonly string[],
  maxOverlapWords = 6,
): number {
  const maxK = Math.min(
    maxOverlapWords,
    runningWords.length,
    incomingWords.length,
  );
  for (let k = maxK; k >= 1; k -= 1) {
    let matches = true;
    for (let i = 0; i < k; i += 1) {
      const tail = runningWords[runningWords.length - k + i];
      const head = incomingWords[i];
      if (
        tail === undefined ||
        head === undefined ||
        wordKey(tail) !== wordKey(head) ||
        wordKey(tail) === "" // don't match on punctuation-only tokens
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return k;
  }
  return 0;
}

/**
 * Accumulates ordered, seam-deduped segment transcripts into one running
 * transcript for live composer rendering. Stateful, single-session; construct a
 * fresh instance per capture turn (or call {@link reset}).
 */
export class CloudSttSessionStitcher {
  /** Committed running words, in order, seam-deduped. */
  private words: string[] = [];
  /** Highest contiguous seq applied so far; -1 before the first segment. */
  private appliedThrough = -1;
  /** Segments received ahead of the contiguous frontier, keyed by seq. */
  private readonly pending = new Map<number, CloudSttSegment>();
  /** True once the final segment's contiguous run has been applied. */
  private finalized = false;
  private readonly maxOverlapWords: number;

  constructor(options: { maxOverlapWords?: number } = {}) {
    this.maxOverlapWords = options.maxOverlapWords ?? 6;
  }

  /** Current stitched running transcript (may be empty before any segment). */
  get running(): string {
    return this.words.join(" ");
  }

  /** True once the final segment has been applied (whole utterance committed). */
  get isDone(): boolean {
    return this.finalized;
  }

  /**
   * Ingest a segment. Applies it (and any now-contiguous buffered successors)
   * if it fills the frontier, else buffers it for later. Idempotent on a
   * re-delivered `seq`. Returns the running transcript after applying whatever
   * became contiguous (unchanged when the segment was buffered/duplicate).
   */
  push(segment: CloudSttSegment): string {
    // Idempotent: an already-applied or negative seq is a no-op (retry that
    // resolved twice, or a stale delivery after teardown).
    if (segment.seq <= this.appliedThrough || segment.seq < 0) {
      return this.running;
    }
    // Buffer a segment that arrives ahead of the frontier; keep the first copy
    // seen for a given seq (idempotent on duplicate delivery).
    if (segment.seq !== this.appliedThrough + 1) {
      if (!this.pending.has(segment.seq)) {
        this.pending.set(segment.seq, segment);
      }
      return this.running;
    }
    // Apply this segment and drain the contiguous run that now follows.
    let next: CloudSttSegment | undefined = segment;
    while (next && next.seq === this.appliedThrough + 1) {
      this.applyContiguous(next);
      this.appliedThrough = next.seq;
      this.pending.delete(next.seq);
      next = this.pending.get(this.appliedThrough + 1);
    }
    return this.running;
  }

  /** Append one already-in-order segment, trimming the duplicated seam. */
  private applyContiguous(segment: CloudSttSegment): void {
    if (segment.isFinal) this.finalized = true;
    const incoming = toWords(segment.text);
    if (incoming.length === 0) return;
    const drop = seamOverlapWordCount(
      this.words,
      incoming,
      this.maxOverlapWords,
    );
    for (let i = drop; i < incoming.length; i += 1) {
      const word = incoming[i];
      if (word !== undefined) this.words.push(word);
    }
  }

  /**
   * Whether every segment up to and including a known-final seq has landed.
   * When a caller knows the final seq (assigned at capture stop) it can poll
   * this to decide the stitched `running` is the whole utterance even if the
   * final segment's own `isFinal` flag was lost to a retry.
   */
  hasContiguousThrough(seq: number): boolean {
    return this.appliedThrough >= seq;
  }

  /** Count of buffered (not-yet-contiguous) segments awaiting a gap fill. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Reset to a fresh session (reuse the instance across capture turns). */
  reset(): void {
    this.words = [];
    this.appliedThrough = -1;
    this.pending.clear();
    this.finalized = false;
  }
}
