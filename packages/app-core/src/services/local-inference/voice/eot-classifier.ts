/**
 * Semantic end-of-turn (EOT) classifier — Tier 3 of the three-tier VAD.
 *
 * Tier 1: RMS energy gate (~10 ms)
 * Tier 2: Silero VAD (~32 ms hop)
 * Tier 3: Semantic EOT classifier — P(turn_complete | transcript_so_far)
 *
 * The classifier operates on the partial transcript text emitted by streaming
 * ASR, not on audio. It returns P(done) ∈ [0, 1]. The voice state machine
 * uses it to:
 *
 *   P(done) ≥ 0.9 AND silence ≥ 50 ms  → commit immediately, skip hangover
 *   P(done) ≥ 0.6 AND silence ≥ 20 ms  → enter PAUSE_TENTATIVE early (start drafter)
 *   P(done) < 0.4                        → extend hangover by 50 ms (mid-clause)
 *
 * Two implementations ship:
 *
 *   `HeuristicEotClassifier` — deterministic, zero-latency, no model load.
 *     This is the baseline; it is always available.
 *
 *   `RemoteEotClassifier` — stub that POSTs to an HTTP endpoint (e.g.
 *     LiveKit turn-detector inference API). Plug in a real model later when
 *     GPU budget is available. Falls back to 0.5 on network error.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * End-of-turn classifier interface. Both implementations satisfy this contract
 * so callers are backend-agnostic.
 */
export interface EotClassifier {
  /** Return P(turn_complete) ∈ [0, 1] for `partialTranscript`. */
  score(partialTranscript: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Heuristic baseline
// ---------------------------------------------------------------------------

/**
 * Rules-of-thumb EOT classifier. The rules fire in priority order; the first
 * match wins.
 *
 * Priority  Signal                                       P(done)
 * --------  -------------------------------------------  -------
 *   1       Sentence-final punctuation (. ! ?)            0.95
 *   2       Question-tag words ("right?", "yeah?", "ok?") 0.85
 *   3       Short utterance (< 3 words)                   0.70
 *   4       Trailing conjunction (and/but/or/because/…)   0.15
 *   5       Last word is a preposition or article         0.20
 *   6       No signal                                     0.50
 */
export class HeuristicEotClassifier implements EotClassifier {
  /** Conjunctions that strongly suggest the user is mid-clause. */
  private static readonly TRAILING_CONJUNCTIONS = new Set([
    "and",
    "but",
    "or",
    "nor",
    "yet",
    "so",
    "because",
    "although",
    "though",
    "while",
    "whereas",
    "if",
    "unless",
    "until",
    "since",
    "when",
    "where",
    "which",
    "that",
    "who",
    "whom",
    "whose",
  ]);

  /** Prepositions and articles that suggest an incomplete NP follows. */
  private static readonly TRAILING_INCOMPLETE = new Set([
    "a",
    "an",
    "the",
    "to",
    "of",
    "in",
    "on",
    "at",
    "by",
    "for",
    "with",
    "from",
    "into",
    "about",
    "through",
    "between",
    "against",
    "during",
    "before",
    "after",
    "without",
    "under",
    "over",
    "above",
    "below",
    "around",
    "beside",
    "beyond",
    "like",
    "near",
    "past",
    "via",
  ]);

  /** Question-tag suffixes that end an utterance (case-insensitive). */
  private static readonly QUESTION_TAGS = [
    "right?",
    "yeah?",
    "ok?",
    "okay?",
    "right",
    "yeah",
    "correct?",
    "correct",
    "hm?",
    "huh?",
    "eh?",
  ];

  score(partialTranscript: string): Promise<number> {
    const text = partialTranscript.trim();
    if (text.length === 0) return Promise.resolve(0.5);

    // Rule 1 — sentence-final punctuation.
    if (/[.!?]$/.test(text)) {
      return Promise.resolve(0.95);
    }

    // Rule 2 — question-tag words at the end.
    const lower = text.toLowerCase();
    for (const tag of HeuristicEotClassifier.QUESTION_TAGS) {
      if (lower.endsWith(tag)) return Promise.resolve(0.85);
    }

    // Split into words for word-level checks.
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/gi, "")
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return Promise.resolve(0.5);

    const lastWord = words[words.length - 1].replace(/[',;:-]+$/, "");

    // Rule 3 — short utterance (< 3 words) → likely complete.
    if (words.length < 3) return Promise.resolve(0.7);

    // Rule 4 — trailing conjunction → mid-clause.
    if (HeuristicEotClassifier.TRAILING_CONJUNCTIONS.has(lastWord)) {
      return Promise.resolve(0.15);
    }

    // Rule 5 — trailing preposition or article → incomplete NP.
    if (HeuristicEotClassifier.TRAILING_INCOMPLETE.has(lastWord)) {
      return Promise.resolve(0.2);
    }

    // Rule 6 — no signal.
    return Promise.resolve(0.5);
  }
}

// ---------------------------------------------------------------------------
// Remote stub (future model plug-in)
// ---------------------------------------------------------------------------

export interface RemoteEotClassifierOptions {
  /**
   * HTTP endpoint to POST the partial transcript to. Expected to return JSON
   * with a `p_done` field: `{ "p_done": 0.92 }`.
   *
   * Example: LiveKit turn-detector inference endpoint or a custom model server.
   */
  endpoint: string;
  /**
   * Timeout in milliseconds for each HTTP request. Default 200 ms — the
   * classifier must be faster than the silence hangover it's trying to beat.
   */
  timeoutMs?: number;
  /**
   * Value returned when the endpoint is unreachable or returns an error.
   * Default 0.5 (uncertain — let silence hangover decide).
   */
  fallbackScore?: number;
}

/**
 * Remote EOT classifier. POSTs `{ transcript: string }` to `endpoint`
 * and expects `{ p_done: number }` back.
 *
 * Intended to be wired to the LiveKit turn-detector HTTP API or a custom
 * model inference server. Falls back to `fallbackScore` on any network or
 * parse error so the voice loop is never blocked.
 */
export class RemoteEotClassifier implements EotClassifier {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fallbackScore: number;

  constructor(opts: RemoteEotClassifierOptions) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs ?? 200;
    this.fallbackScore = opts.fallbackScore ?? 0.5;
  }

  async score(partialTranscript: string): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: partialTranscript }),
        signal: controller.signal,
      });
      if (!response.ok) return this.fallbackScore;
      const json = (await response.json()) as unknown;
      if (
        typeof json === "object" &&
        json !== null &&
        "p_done" in json &&
        typeof (json as Record<string, unknown>).p_done === "number"
      ) {
        const p = (json as { p_done: number }).p_done;
        // Clamp to [0, 1] in case the model returns slightly out-of-range values.
        return Math.max(0, Math.min(1, p));
      }
      return this.fallbackScore;
    } catch {
      return this.fallbackScore;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Thresholds (shared constants so tests and state machine stay in sync)
// ---------------------------------------------------------------------------

/** P(done) ≥ this AND silence ≥ EOT_COMMIT_SILENCE_MS → commit immediately. */
export const EOT_COMMIT_THRESHOLD = 0.9;

/** P(done) ≥ this AND silence ≥ EOT_TENTATIVE_SILENCE_MS → enter PAUSE_TENTATIVE early. */
export const EOT_TENTATIVE_THRESHOLD = 0.6;

/** P(done) < this → extend hangover by EOT_HANGOVER_EXTENSION_MS. */
export const EOT_MID_CLAUSE_THRESHOLD = 0.4;

/** Minimum silence (ms) required alongside P ≥ EOT_COMMIT_THRESHOLD to commit. */
export const EOT_COMMIT_SILENCE_MS = 50;

/** Minimum silence (ms) required alongside P ≥ EOT_TENTATIVE_THRESHOLD to start drafter. */
export const EOT_TENTATIVE_SILENCE_MS = 20;

/** How many ms to add to the pause hangover when P < EOT_MID_CLAUSE_THRESHOLD. */
export const EOT_HANGOVER_EXTENSION_MS = 50;
