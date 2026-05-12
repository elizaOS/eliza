import type { PhonemeTokenizer } from "./phoneme-tokenizer";
import type {
  AcceptedToken,
  PhraseChunkerConfig as BasePhraseChunkerConfig,
  Phrase,
  TextToken,
} from "./types";

/**
 * T3 — extension of the base `PhraseChunkerConfig` with the time-budget
 * field. Kept as a local extension because `types.ts` is owned by another
 * agent in this Phase 0 / Phase 1 sweep; the base config is structurally
 * a subset so any caller passing the narrower type still type-checks.
 */
export interface PhraseChunkerConfig extends BasePhraseChunkerConfig {
  /**
   * T3 — maximum milliseconds a phrase may accumulate in the buffer
   * before the chunker force-flushes, even without a punctuation /
   * phoneme / max-cap boundary. Default 200 ms. Set to 0 to disable.
   */
  maxAccumulationMs?: number;
}

/**
 * Default phrase boundaries: end-of-clause punctuation plus the three
 * sentence-final marks. Per `packages/inference/AGENTS.md` §4 / the
 * voice-swarm brief item A6 — "the first segment delimited by punctuation
 * OR the first 30 words, whichever comes first". Cutting a phrase at the
 * first comma/semicolon/colon hands TTS something to say without waiting
 * for a sentence-final mark.
 */
const DEFAULT_TERMINATORS: ReadonlySet<string> = new Set([
  ",",
  ".",
  "!",
  "?",
  ";",
  ":",
]);
const DEFAULT_PHONEMES_PER_CHUNK = 8;
/** Default hard word cap when a caller doesn't supply `maxTokensPerPhrase` (the brief's "first 30 words"). */
const DEFAULT_MAX_TOKENS_PER_PHRASE = 30;
/**
 * T3 — default time budget in milliseconds for the time-budget phrase
 * flush. When a phrase has been accumulating in the buffer for this long
 * without hitting a punctuation / phoneme / cap boundary, force a flush
 * so the next phrase reaches TTS instead of stalling behind a slow
 * producer.
 */
const DEFAULT_MAX_ACCUMULATION_MS = 200;

/** Wall-clock source the chunker uses. Tests inject a deterministic clock. */
export type ClockMs = () => number;

const DEFAULT_CLOCK: ClockMs = () =>
  globalThis.performance?.now?.() ?? Date.now();

export class PhraseChunker {
  private buffer: AcceptedToken[] = [];
  private nextPhraseId = 0;
  private readonly terminators: ReadonlySet<string>;
  private readonly chunkOn: "punctuation" | "phoneme-stream";
  private readonly phonemesPerChunk: number;
  private readonly maxTokensPerPhrase: number;
  private readonly tokenizer: PhonemeTokenizer | null;
  private phonemeCount = 0;
  /**
   * T3 — time-budget flush. `firstTokenAtMs` is captured on the first
   * `push()` after an empty buffer; once `clock() - firstTokenAtMs >=
   * maxAccumulationMs` the chunker force-flushes even without a
   * punctuation / phoneme / cap boundary. `maxAccumulationMs <= 0`
   * disables the time budget.
   */
  private readonly maxAccumulationMs: number;
  private readonly clock: ClockMs;
  private firstTokenAtMs = 0;

  constructor(
    config: PhraseChunkerConfig,
    tokenizer: PhonemeTokenizer | null = null,
    clock: ClockMs = DEFAULT_CLOCK,
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
    this.maxAccumulationMs =
      config.maxAccumulationMs !== undefined
        ? Math.max(0, config.maxAccumulationMs)
        : DEFAULT_MAX_ACCUMULATION_MS;
    this.clock = clock;
    this.tokenizer = tokenizer;
    if (this.chunkOn === "phoneme-stream" && this.tokenizer === null) {
      throw new Error(
        "PhraseChunker: chunkOn='phoneme-stream' requires a PhonemeTokenizer (pass CharacterPhonemeStub for testing or a real tokenizer for production)",
      );
    }
  }

  push(token: AcceptedToken): Phrase | null {
    if (this.buffer.length === 0) {
      this.firstTokenAtMs = this.clock();
    }
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

    // T3 — time-budget flush. Re-uses the `"max-cap"` terminator because
    // adding a new terminator value would require editing the shared
    // `Phrase` type in `types.ts`, which is owned by another agent in
    // this sweep. Structurally "the chunker forced a flush" is what
    // max-cap already means.
    if (
      this.maxAccumulationMs > 0 &&
      this.clock() - this.firstTokenAtMs >= this.maxAccumulationMs
    ) {
      return this.flushAs("max-cap");
    }
    return null;
  }

  /**
   * T3 — caller-driven check. Returns a phrase when the time budget has
   * elapsed for the current buffer, otherwise null. The scheduler polls
   * this from a `setTimeout` so even a producer that goes silent before
   * pushing the next token still gets its in-flight phrase flushed.
   */
  flushIfTimeBudgetExceeded(): Phrase | null {
    if (this.buffer.length === 0) return null;
    if (this.maxAccumulationMs <= 0) return null;
    if (this.clock() - this.firstTokenAtMs < this.maxAccumulationMs) {
      return null;
    }
    return this.flushAs("max-cap");
  }

  /**
   * T3 — milliseconds remaining until the time budget elapses for the
   * current buffer. Negative when the budget has already been exceeded;
   * `Number.POSITIVE_INFINITY` when the buffer is empty or the budget is
   * disabled. Callers compute their flush timer off this.
   */
  msUntilTimeBudget(): number {
    if (this.buffer.length === 0) return Number.POSITIVE_INFINITY;
    if (this.maxAccumulationMs <= 0) return Number.POSITIVE_INFINITY;
    return this.firstTokenAtMs + this.maxAccumulationMs - this.clock();
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
    if (this.buffer.length === 0) {
      this.firstTokenAtMs = 0;
    }
    if (this.chunkOn === "phoneme-stream" && this.tokenizer !== null) {
      for (const t of this.buffer) {
        this.phonemeCount += this.tokenizer.tokenize(t.text, t.index).length;
      }
    }
  }

  reset(): void {
    this.buffer = [];
    this.phonemeCount = 0;
    this.firstTokenAtMs = 0;
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
    this.firstTokenAtMs = 0;
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
