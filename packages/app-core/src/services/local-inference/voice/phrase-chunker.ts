import type { PhonemeTokenizer } from "./phoneme-tokenizer";
import type {
  AcceptedToken,
  Phrase,
  PhraseChunkerConfig,
  TextToken,
} from "./types";

/**
 * Default phrase boundaries: end-of-clause comma plus the three
 * sentence-final marks. Per `packages/inference/AGENTS.md` §4 / the
 * voice-swarm brief item A6 — "the first segment delimited by `, . ! ?`
 * OR the first 30 words, whichever comes first". Cutting a phrase at the
 * first comma hands TTS something to say without waiting for a
 * sentence-final mark.
 */
const DEFAULT_TERMINATORS: ReadonlySet<string> = new Set([",", ".", "!", "?"]);
const DEFAULT_PHONEMES_PER_CHUNK = 8;
/** Default hard word cap when a caller doesn't supply `maxTokensPerPhrase` (the brief's "first 30 words"). */
const DEFAULT_MAX_TOKENS_PER_PHRASE = 30;

export class PhraseChunker {
  private buffer: AcceptedToken[] = [];
  private nextPhraseId = 0;
  private readonly terminators: ReadonlySet<string>;
  private readonly chunkOn: "punctuation" | "phoneme-stream";
  private readonly phonemesPerChunk: number;
  private readonly maxTokensPerPhrase: number;
  private readonly tokenizer: PhonemeTokenizer | null;
  private phonemeCount = 0;

  constructor(
    config: PhraseChunkerConfig,
    tokenizer: PhonemeTokenizer | null = null,
  ) {
    this.terminators = config.sentenceTerminators ?? DEFAULT_TERMINATORS;
    this.chunkOn = config.chunkOn ?? "punctuation";
    this.phonemesPerChunk = Math.max(
      1,
      config.phonemesPerChunk ?? DEFAULT_PHONEMES_PER_CHUNK,
    );
    this.maxTokensPerPhrase = Math.max(
      1,
      config.maxTokensPerPhrase ?? DEFAULT_MAX_TOKENS_PER_PHRASE,
    );
    this.tokenizer = tokenizer;
    if (this.chunkOn === "phoneme-stream" && this.tokenizer === null) {
      throw new Error(
        "PhraseChunker: chunkOn='phoneme-stream' requires a PhonemeTokenizer (pass CharacterPhonemeStub for testing or a real tokenizer for production)",
      );
    }
  }

  push(token: AcceptedToken): Phrase | null {
    this.buffer.push(token);

    // Punctuation always wins — a `, . ! ?` boundary forces a flush even
    // in phoneme-stream mode.
    if (this.endsWithTerminator(token.text)) {
      return this.flushAs("punctuation");
    }

    if (this.chunkOn === "phoneme-stream" && this.tokenizer !== null) {
      const phonemes = this.tokenizer.tokenize(token.text, token.index);
      this.phonemeCount += phonemes.length;
      if (this.phonemeCount >= this.phonemesPerChunk) {
        return this.flushAs("phoneme-stream");
      }
    }

    if (this.buffer.length >= this.maxTokensPerPhrase) {
      return this.flushAs("max-cap");
    }
    return null;
  }

  flushPending(): Phrase | null {
    if (this.buffer.length === 0) return null;
    return this.flushAs("max-cap");
  }

  /**
   * Drop buffered (not-yet-flushed) tokens whose token index is ≥
   * `fromIndex`. Used by the pipeline's rollback path: when the target
   * verifier rejects a draft tail, any draft tokens still sitting in the
   * chunker's buffer (not yet packed into a phrase) MUST be discarded so
   * the verifier's correction does not get glued onto stale text.
   * Phonemes are recounted from scratch over what remains.
   */
  dropPendingFrom(fromIndex: number): void {
    const kept = this.buffer.filter((t) => t.index < fromIndex);
    if (kept.length === this.buffer.length) return;
    this.buffer = kept;
    this.phonemeCount = 0;
    if (this.chunkOn === "phoneme-stream" && this.tokenizer !== null) {
      for (const t of this.buffer) {
        this.phonemeCount += this.tokenizer.tokenize(t.text, t.index).length;
      }
    }
  }

  reset(): void {
    this.buffer = [];
    this.phonemeCount = 0;
  }

  private endsWithTerminator(text: string): boolean {
    if (text.length === 0) return false;
    const last = text[text.length - 1];
    return this.terminators.has(last);
  }

  private flushAs(terminator: Phrase["terminator"]): Phrase {
    const tokens = this.buffer;
    this.buffer = [];
    this.phonemeCount = 0;
    const fromIndex = tokens[0].index;
    const toIndex = tokens[tokens.length - 1].index;
    const text = tokens.map((t) => t.text).join("");
    const phrase: Phrase = {
      id: this.nextPhraseId++,
      text,
      fromIndex,
      toIndex,
      terminator,
    };
    return phrase;
  }
}

export function chunkTokens(
  tokens: TextToken[],
  config: PhraseChunkerConfig,
  acceptedAt = 0,
  tokenizer: PhonemeTokenizer | null = null,
): Phrase[] {
  const chunker = new PhraseChunker(config, tokenizer);
  const phrases: Phrase[] = [];
  for (const t of tokens) {
    const p = chunker.push({ ...t, acceptedAt });
    if (p) phrases.push(p);
  }
  const tail = chunker.flushPending();
  if (tail) phrases.push(tail);
  return phrases;
}
