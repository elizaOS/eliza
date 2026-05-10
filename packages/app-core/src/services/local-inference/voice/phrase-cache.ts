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
