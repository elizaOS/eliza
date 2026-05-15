/**
 * Stream-driven phrase-chunked TTS adapter.
 *
 * Wraps any TTS handler (Edge TTS, ElevenLabs, OpenAI, omnivoice — anything
 * that takes a string and returns audio) so that a streaming LLM response
 * can be spoken out progressively: the first sentence/clause hits TTS as
 * soon as the chunker accepts a boundary, then subsequent phrases follow
 * while the LLM is still emitting tokens.
 *
 * Why this lives in app-core: the canonical phrase boundary policy
 * (`PhraseChunker` — commas/semicolons/colons + 30-word cap + 700 ms time
 * budget) is owned by the local-inference voice subsystem. This adapter
 * makes that policy reusable from the REMOTE chat→TTS path (Discord,
 * dashboard SSE→synthesis, phone) where the LLM streams text but the TTS
 * backend only accepts complete strings.
 *
 * Latency contract:
 *   - First TTS call fires on the first punctuation boundary OR on the
 *     max-token cap (default 30 words), whichever lands first.
 *   - If the producer stalls between tokens for >= the time-budget window
 *     (default 700 ms), the in-flight phrase is force-flushed so audio
 *     never waits on a slow upstream.
 *   - `finish()` drains the tail phrase exactly once.
 *
 * This module is intentionally side-effect free: callers supply the TTS
 * function and the audio sink. We don't decode, we don't queue audio —
 * we just hand sentence-sized strings to the TTS function in order.
 */

export interface AcceptedToken {
  index: number;
  text: string;
  id?: number;
  acceptedAt: number;
}

export interface Phrase {
  id: number;
  text: string;
  fromIndex: number;
  toIndex: number;
  terminator: "punctuation" | "max-cap" | "phoneme-stream";
}

export interface PhraseChunkerConfig {
  maxTokensPerPhrase?: number;
  sentenceTerminators?: ReadonlySet<string>;
  chunkOn?: "punctuation" | "phoneme-stream";
  phonemesPerChunk?: number;
  maxAccumulationMs?: number;
}

interface PhraseChunker {
  push(token: AcceptedToken): Phrase | null;
  flushPending(): Phrase | null;
  reset(): void;
  msUntilTimeBudget(): number;
  flushIfTimeBudgetExceeded(): Phrase | null;
}

type PhraseChunkerConstructor = new (
  config: PhraseChunkerConfig,
  tokenizer: unknown,
  clock: () => number,
) => PhraseChunker;

// Lazy module reference — avoids a static boundary violation while preserving
// synchronous construction semantics for callers that supply the PhraseChunker
// class via `PhraseChunkedTtsOptions.chunkerClass` (used in tests).
let _PhraseChunkerClass: PhraseChunkerConstructor | undefined;
let _servicesImport:
  | Promise<{ PhraseChunker: PhraseChunkerConstructor }>
  | undefined;
function requirePhraseChunker(): PhraseChunkerConstructor {
  if (_PhraseChunkerClass) return _PhraseChunkerClass;
  throw new Error(
    "PhraseChunker not yet loaded — call await PhraseChunkedTts.load() before constructing instances, or provide chunkerClass in options.",
  );
}
/** Pre-warm the PhraseChunker class. Called automatically when the first
 *  PhraseChunkedTts is instantiated if the class hasn't been loaded yet. */
async function ensurePhraseChunkerLoaded(): Promise<void> {
  if (_PhraseChunkerClass) return;
  _servicesImport ??= import(
    "@elizaos/plugin-local-inference/services"
  ) as unknown as Promise<{
    PhraseChunker: PhraseChunkerConstructor;
  }>;
  const mod = await _servicesImport;
  _PhraseChunkerClass = mod.PhraseChunker;
}

export interface PhraseChunkedTtsOptions {
  /** Phrase chunker configuration. See `PhraseChunkerConfig`. */
  chunker?: PhraseChunkerConfig;
  /**
   * Optional clock override for tests. Defaults to `performance.now()`.
   */
  clock?: () => number;
  /**
   * Called once per phrase that's been handed to the TTS handler, after
   * the handler resolves. Receives the phrase + TTS output. Use this to
   * push audio into your sink (HTTP chunked transfer, MediaSource, Discord
   * AudioPlayer, etc.).
   */
  onAudio?: (phrase: Phrase, audio: unknown) => void | Promise<void>;
  /**
   * Called when the chunker emits a phrase but BEFORE the TTS handler is
   * invoked. Use for tracing — e.g. `markVoiceLatency(roomId, "phrase-1-to-tts")`.
   */
  onPhraseEmit?: (phrase: Phrase) => void;
  /**
   * Called when a TTS handler call rejects. Default: rethrow on
   * `finish()`. Set to `"swallow"` to log + continue (next phrase still
   * goes to TTS). The handler error itself is passed for logging.
   */
  onTtsError?: (phrase: Phrase, err: unknown) => "swallow" | "fail";
}

export type TtsHandler = (text: string) => Promise<unknown> | unknown;

/**
 * A phrase-chunked TTS pipeline. Push raw streaming chunks via `push()`;
 * call `finish()` after the LLM stream ends to flush the tail phrase and
 * await all in-flight TTS calls.
 *
 * Usage:
 *   const pipe = new PhraseChunkedTts(ttsHandler, { onAudio: writeToSink });
 *   for await (const chunk of llmStream) pipe.push(chunk);
 *   await pipe.finish();
 */
export class PhraseChunkedTts {
  private readonly chunker: PhraseChunker;
  private readonly clock: () => number;
  private readonly tts: TtsHandler;
  private readonly opts: PhraseChunkedTtsOptions;
  private tokenIndex = 0;
  /** In-flight TTS promises so `finish()` can await playback ordering. */
  private readonly inflight: Promise<unknown>[] = [];
  private timeBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  private firstError: unknown = null;
  private closed = false;

  constructor(tts: TtsHandler, opts: PhraseChunkedTtsOptions = {}) {
    this.tts = tts;
    this.opts = opts;
    this.clock =
      opts.clock ?? (() => globalThis.performance?.now?.() ?? Date.now());
    const Chunker = requirePhraseChunker();
    this.chunker = new Chunker(
      opts.chunker ?? { chunkOn: "punctuation" },
      null,
      this.clock,
    );
  }

  /**
   * Pre-load the PhraseChunker class from plugin-local-inference. Must be
   * called (and awaited) before the first `new PhraseChunkedTts()` when the
   * module has not been statically imported. Idempotent — safe to call
   * multiple times concurrently.
   */
  static async load(): Promise<void> {
    await ensurePhraseChunkerLoaded();
  }

  /**
   * Push a streaming LLM chunk. May span multiple words. Phrase boundaries
   * are detected by the chunker; when one fires, the phrase text is handed
   * to the TTS handler immediately (its returned promise is tracked).
   */
  push(chunk: string): void {
    if (this.closed) {
      throw new Error("PhraseChunkedTts.push() called after finish()");
    }
    if (!chunk) return;
    const token: AcceptedToken = {
      index: this.tokenIndex++,
      text: chunk,
      acceptedAt: this.clock(),
    };
    const phrase = this.chunker.push(token);
    if (phrase) {
      this.dispatchPhrase(phrase);
    }
    this.scheduleTimeBudget();
  }

  /**
   * Drain the tail phrase (if any) and await all in-flight TTS calls.
   * Returns when every dispatched phrase has resolved or rejected. After
   * `finish()` the pipeline cannot be reused.
   */
  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timeBudgetTimer) {
      clearTimeout(this.timeBudgetTimer);
      this.timeBudgetTimer = null;
    }
    const tail = this.chunker.flushPending();
    if (tail) this.dispatchPhrase(tail);
    // Settle every TTS call; rethrow the first error if any (unless caller
    // chose to swallow).
    await Promise.all(this.inflight.map((p) => p.catch(() => undefined)));
    if (this.firstError !== null) throw this.firstError;
  }

  /** Cancel without awaiting in-flight TTS. Safe to call after `finish()`. */
  cancel(): void {
    this.closed = true;
    if (this.timeBudgetTimer) {
      clearTimeout(this.timeBudgetTimer);
      this.timeBudgetTimer = null;
    }
    this.chunker.reset();
  }

  private dispatchPhrase(phrase: Phrase): void {
    this.opts.onPhraseEmit?.(phrase);
    const ttsCall = Promise.resolve()
      .then(() => this.tts(phrase.text))
      .then(async (audio) => {
        if (this.opts.onAudio) {
          await this.opts.onAudio(phrase, audio);
        }
        return audio;
      })
      .catch((err) => {
        const mode = this.opts.onTtsError?.(phrase, err) ?? "fail";
        if (mode === "swallow") return undefined;
        if (this.firstError === null) this.firstError = err;
        return undefined;
      });
    this.inflight.push(ttsCall);
  }

  /**
   * Re-arm the time-budget timer. The chunker has an internal time-budget
   * flush, but it only checks at `push()` time — a producer that goes
   * silent before pushing the next token would stall an in-flight phrase
   * forever. The timer polls the chunker once the budget window elapses
   * with no new pushes.
   */
  private scheduleTimeBudget(): void {
    if (this.closed) return;
    if (this.timeBudgetTimer) {
      clearTimeout(this.timeBudgetTimer);
      this.timeBudgetTimer = null;
    }
    const msUntil = this.chunker.msUntilTimeBudget();
    if (!Number.isFinite(msUntil) || msUntil <= 0) {
      // Already past the budget — flush now.
      const flushed = this.chunker.flushIfTimeBudgetExceeded();
      if (flushed) this.dispatchPhrase(flushed);
      return;
    }
    this.timeBudgetTimer = setTimeout(
      () => {
        this.timeBudgetTimer = null;
        const flushed = this.chunker.flushIfTimeBudgetExceeded();
        if (flushed) this.dispatchPhrase(flushed);
      },
      Math.max(1, Math.ceil(msUntil)),
    );
    // Don't keep the event loop alive for a stalled chunker.
    const t = this.timeBudgetTimer as { unref?: () => void } | null;
    if (t?.unref) t.unref();
  }
}

/**
 * One-shot helper: drive an async iterable of text chunks through
 * `PhraseChunkedTts`. Returns when the iterable is exhausted and all TTS
 * calls have settled. Exists so SSE/streaming callers don't have to write
 * the for-await boilerplate.
 */
export async function speakStreamingText(
  source: AsyncIterable<string>,
  tts: TtsHandler,
  opts: PhraseChunkedTtsOptions = {},
): Promise<void> {
  await ensurePhraseChunkerLoaded();
  const pipe = new PhraseChunkedTts(tts, opts);
  try {
    for await (const chunk of source) pipe.push(chunk);
  } finally {
    await pipe.finish();
  }
}
