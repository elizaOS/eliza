export interface CachedPhraseAudio {
  text: string;
  pcm: Float32Array;
  sampleRate: number;
}

export interface PhraseCacheOptions {
  /** Maximum distinct phrase texts retained. Older non-accessed entries
   * are evicted first. */
  maxEntries?: number;
  /**
   * Guardrail for live opportunistic caching. Long-form direct TTS can be
   * megabytes of PCM and is not a good phrase-cache resident.
   */
  maxPcmSamplesPerEntry?: number;
}

export function canonicalizePhraseText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_PCM_SAMPLES_PER_ENTRY = 24000 * 8;

export class PhraseCache {
  private readonly entries = new Map<string, CachedPhraseAudio>();
  private readonly maxEntries: number;
  private readonly maxPcmSamplesPerEntry: number;

  constructor(opts: PhraseCacheOptions = {}) {
    this.maxEntries = Math.max(
      1,
      Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES),
    );
    this.maxPcmSamplesPerEntry = Math.max(
      1,
      Math.floor(
        opts.maxPcmSamplesPerEntry ?? DEFAULT_MAX_PCM_SAMPLES_PER_ENTRY,
      ),
    );
  }

  put(entry: CachedPhraseAudio): void {
    if (entry.pcm.length > this.maxPcmSamplesPerEntry) return;
    const key = canonicalizePhraseText(entry.text);
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictOverflow();
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
      this.entries.set(canonicalizePhraseText(e.text), {
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
