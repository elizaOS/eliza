import type {
  AcceptedToken,
  Phrase,
  PhraseChunkerConfig,
  TextToken,
} from "./types";

const DEFAULT_TERMINATORS: ReadonlySet<string> = new Set([".", "!", "?"]);

export class PhraseChunker {
  private buffer: AcceptedToken[] = [];
  private nextPhraseId = 0;
  private readonly terminators: ReadonlySet<string>;

  constructor(private readonly config: PhraseChunkerConfig) {
    this.terminators = config.sentenceTerminators ?? DEFAULT_TERMINATORS;
  }

  push(token: AcceptedToken): Phrase | null {
    this.buffer.push(token);

    if (this.endsWithTerminator(token.text)) {
      return this.flushAs("punctuation");
    }
    if (this.buffer.length >= this.config.maxTokensPerPhrase) {
      return this.flushAs("max-cap");
    }
    return null;
  }

  flushPending(): Phrase | null {
    if (this.buffer.length === 0) return null;
    return this.flushAs("max-cap");
  }

  reset(): void {
    this.buffer = [];
  }

  private endsWithTerminator(text: string): boolean {
    if (text.length === 0) return false;
    const last = text[text.length - 1];
    return this.terminators.has(last);
  }

  private flushAs(terminator: Phrase["terminator"]): Phrase {
    const tokens = this.buffer;
    this.buffer = [];
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
): Phrase[] {
  const chunker = new PhraseChunker(config);
  const phrases: Phrase[] = [];
  for (const t of tokens) {
    const p = chunker.push({ ...t, acceptedAt });
    if (p) phrases.push(p);
  }
  const tail = chunker.flushPending();
  if (tail) phrases.push(tail);
  return phrases;
}
