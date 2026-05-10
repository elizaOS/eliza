export interface CachedPhraseAudio {
  text: string;
  pcm: Float32Array;
  sampleRate: number;
}

export function canonicalizePhraseText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export class PhraseCache {
  private readonly entries = new Map<string, CachedPhraseAudio>();

  put(entry: CachedPhraseAudio): void {
    this.entries.set(canonicalizePhraseText(entry.text), entry);
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
    return this.entries.get(canonicalizePhraseText(text));
  }

  has(text: string): boolean {
    return this.entries.has(canonicalizePhraseText(text));
  }

  size(): number {
    return this.entries.size;
  }
}
