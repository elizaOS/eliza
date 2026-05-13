export interface CachedPhraseAudio {
  text: string;
  pcm: Float32Array;
  sampleRate: number;
}

/**
 * Canonical seed list for the voice phrase cache: short openers, fillers, and
 * acknowledgements the assistant emits constantly. Pre-synthesizing these and
 * holding their PCM in `PhraseCache` removes the TTS forward pass from the
 * critical path for the most common first utterances — `dispatchPhrase` hits
 * the cache and writes audio to the ring buffer on the same tick.
 *
 * Used by:
 *   - the preset generator (`scripts/voice-preset/build-default-voice-preset.mjs`),
 *     which synthesizes these against a real OmniVoice TTS backend and writes
 *     the PCM into `cache/voice-preset-default.bin` — the seeded source of truth.
 *   - `EngineVoiceBridge.start()` indirectly: the bundle's preset ships these
 *     phrases with their PCM, which `PhraseCache.seed(...)` loads at startup.
 *   - the idle-time auto-prewarm hook (`EngineVoiceBridge.prewarmIdlePhrases`),
 *     which only runs when a real TTS backend is present — never against the
 *     stub (caching zeros is not a phrase cache).
 *   - the first-audio filler (`FIRST_AUDIO_FILLERS` is a subset).
 *
 * Entries are kept here in canonical form (lowercase, single-spaced, trimmed)
 * so the preset generator and the runtime agree byte-for-byte on the keys.
 */
export const DEFAULT_PHRASE_CACHE_SEED: ReadonlyArray<string> = [
  // Immediate acknowledgements — "I heard you, working on it".
  "okay",
  "got it",
  "sure",
  "right",
  "on it",
  "one sec",
  "one second",
  "let me check",
  "let me see",
  "give me a moment",
  // Conversational openers / fillers — natural sentence starters the planner
  // emits before the substantive answer streams in.
  "okay so",
  "so",
  "hmm",
  "well",
  "alright",
  "sure thing",
  "of course",
  "no problem",
  "good question",
  "let me think",
];

/**
 * The subset of `DEFAULT_PHRASE_CACHE_SEED` suitable to play the instant VAD
 * fires `speech-start`, masking first-token latency (AGENTS.md §4 / H4). Kept
 * short and uncommitted — anything that takes a stance ("of course") is
 * excluded so the filler never contradicts the eventual reply. The first
 * entry found in the phrase cache wins.
 */
export const FIRST_AUDIO_FILLERS: ReadonlyArray<string> = [
  "one sec",
  "okay",
  "let me check",
  "hmm",
  "got it",
];

export interface PhraseCacheOptions {
  /** Maximum distinct phrase texts retained. Older non-accessed entries
   * are evicted first. */
  maxEntries?: number;
  /**
   * Opportunistic live-cache guardrail. Voice mode primarily benefits from
   * cached acknowledgements and first sentence fragments; longer text is less
   * likely to repeat and can evict useful hot phrases.
   */
  maxEstimatedTokensPerEntry?: number;
  /**
   * Guardrail for live opportunistic caching. Long-form direct TTS can be
   * megabytes of PCM and is not a good phrase-cache resident.
   */
  maxPcmSamplesPerEntry?: number;
}

export function canonicalizePhraseText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function estimatePhraseTokenCount(text: string): number {
  const normalized = canonicalizePhraseText(text);
  if (!normalized) return 0;
  return normalized.split(/\s+/).length;
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_ESTIMATED_TOKENS_PER_ENTRY = 9;
const DEFAULT_MAX_PCM_SAMPLES_PER_ENTRY = 24000 * 8;

export class PhraseCache {
  private readonly entries = new Map<string, CachedPhraseAudio>();
  private readonly maxEntries: number;
  private readonly maxEstimatedTokensPerEntry: number;
  private readonly maxPcmSamplesPerEntry: number;

  constructor(opts: PhraseCacheOptions = {}) {
    this.maxEntries = Math.max(
      1,
      Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES),
    );
    this.maxEstimatedTokensPerEntry = Math.max(
      1,
      Math.floor(
        opts.maxEstimatedTokensPerEntry ??
          DEFAULT_MAX_ESTIMATED_TOKENS_PER_ENTRY,
      ),
    );
    this.maxPcmSamplesPerEntry = Math.max(
      1,
      Math.floor(
        opts.maxPcmSamplesPerEntry ?? DEFAULT_MAX_PCM_SAMPLES_PER_ENTRY,
      ),
    );
  }

  put(entry: CachedPhraseAudio): boolean {
    const key = canonicalizePhraseText(entry.text);
    if (!key) return false;
    if (entry.pcm.length > this.maxPcmSamplesPerEntry) return false;
    if (
      estimatePhraseTokenCount(entry.text) > this.maxEstimatedTokensPerEntry
    ) {
      return false;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictOverflow();
    return true;
  }

  /**
   * Pre-populate the cache from a voice-preset seed list. Texts are stored
   * verbatim — callers (the format reader) are responsible for canonicalizing
   * before serialization, but we re-canonicalize on insert to be safe.
   */
  seed(
    entries: ReadonlyArray<{
      text: string;
      pcm: Float32Array;
      sampleRate: number;
    }>,
  ): void {
    for (const e of entries) {
      this.put({
        text: e.text,
        pcm: e.pcm,
        sampleRate: e.sampleRate,
      });
    }
  }

  get(text: string): CachedPhraseAudio | undefined {
    const key = canonicalizePhraseText(text);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  has(text: string): boolean {
    return this.entries.has(canonicalizePhraseText(text));
  }

  size(): number {
    return this.entries.size;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
