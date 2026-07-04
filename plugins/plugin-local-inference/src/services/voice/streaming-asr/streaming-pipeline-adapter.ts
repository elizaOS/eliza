/**
 * Streaming-ASR mode selection + partial stabilization for the engine
 * bridge's live ASR path (#12254).
 *
 * `EngineVoiceBridge.createStreamingTranscriber` picks the transcription
 * drive mode via `pickStreamingMode` — the fused streaming decoder is used
 * only when the loaded build advertises it (`asrStreamSupported() === 1`),
 * the ASR bundle is on disk, AND `ELIZA_VOICE_STREAMING_ASR` is not
 * disabled (default ON when supported). Any other combination keeps the
 * interim windowed-batch adapter (`FfiBatchTranscriber`), announced loudly
 * at the bridge — never a silent downgrade.
 *
 * In streaming mode every raw hypothesis is passed through a word-level
 * LocalAgreement-2 gate before downstream consumers see it, so the
 * speculative drafter, barge-in word-confirm, and turn-signal refresh only
 * ever observe a monotonically growing committed prefix — never a
 * retracted word. Two stabilizer variants serve two consumer classes:
 *
 *   - `LocalAgreementBuffer` (word-level, here) — feeds the drafter /
 *     verifier / word-confirm consumers, which operate on word tokens.
 *   - `PartialStabilizer` (`../partial-stabilizer.ts`, character-prefix) —
 *     serves UI caption rendering, where sub-word agreement ("sa" → "sat")
 *     keeps captions responsive.
 *
 * `StreamingAsrFeeder` is the per-turn drive for connector integrations:
 * route mic PCM through `feedFrame()`, `finalize()` on VAD `speech-end`;
 * the final transcript seeds the drafter exactly like the batch path
 * (`splitTranscriptToTokens(final.partial, 0, final.tokens)`). The batch
 * path (`VoicePipeline.transcribeAll`) is unchanged — no fork in
 * `pipeline.ts`.
 */

import { splitTranscriptToTokens } from "../pipeline";
import type {
	PcmFrame,
	StreamingTranscriber,
	TextToken,
	TranscriberEvent,
	TranscriberEventListener,
	TranscriptUpdate,
} from "../types";

/* ==================================================================== *
 * LocalAgreementBuffer — word-level streaming-ASR partial stabilizer.
 *
 * Streaming ASR emits a fresh word-sequence hypothesis on every audio
 * frame. Individual words near the end of the hypothesis can change
 * across frames ("sat" → "cap" → "sat") before settling. This buffer
 * applies LocalAgreement-n (n=2 default) at the word level: a word is
 * emitted to downstream only when it appears at the same position in n
 * consecutive hypotheses. The committed stable prefix is monotonically
 * non-decreasing — once a word is committed it is never retracted.
 *
 * Word-level (not character-level): suited for the VAD pipeline adapter
 * where downstream consumers (drafter, verifier) operate on word tokens.
 * For the character-level prefix variant, see `partial-stabilizer.ts`.
 * ==================================================================== */

/**
 * LocalAgreement-n word-level partial stabilizer.
 *
 * Usage:
 *   const buf = new LocalAgreementBuffer();
 *   const stable = buf.stable(["hello", "there", "world"]);
 *   // → [] on first call (need n=2 consecutive identical prefix)
 *   const stable2 = buf.stable(["hello", "there", "how"]);
 *   // → ["hello", "there"] (matched across two consecutive hypotheses)
 */
export class LocalAgreementBuffer {
	private readonly n: number;
	/** Rolling window of the last `n` hypotheses, oldest first. */
	private window: string[][] = [];
	/** Monotonically growing committed word list. */
	private committed: string[] = [];

	constructor(n = 2) {
		if (!Number.isFinite(n) || n < 1) {
			throw new Error(
				`[LocalAgreementBuffer] n must be a finite integer >= 1; got ${String(n)}`,
			);
		}
		this.n = Math.floor(n);
	}

	/**
	 * Feed the latest word-level hypothesis. Returns the stable committed
	 * prefix — the longest leading word sequence that has appeared
	 * identically in `n` consecutive calls. Monotonically non-decreasing.
	 *
	 * A rolling window of the last `n` hypotheses is maintained. Once the
	 * window is full, the agreed prefix is the intersection across all `n`
	 * entries — word i is in the agreed prefix only if it is identical in
	 * every hypothesis in the window.
	 */
	stable(current: string[]): string[] {
		this.window.push(current);
		if (this.window.length > this.n) {
			this.window.shift();
		}
		// Need a full window of `n` hypotheses before any word can be agreed.
		if (this.window.length < this.n) {
			return this.committed;
		}
		// Intersect: the agreed prefix is the longest common leading prefix
		// across all entries in the window.
		const first = this.window[0];
		if (!first) {
			throw new Error("hypothesis window unexpectedly empty");
		}
		let agreedLen = first.length;
		for (let i = 1; i < this.window.length; i++) {
			const h = this.window[i];
			if (!h) {
				throw new Error(`missing hypothesis at index ${i}`);
			}
			let matchLen = 0;
			const limit = Math.min(agreedLen, h.length);
			for (let j = 0; j < limit; j++) {
				if (first[j] === h[j]) matchLen++;
				else break;
			}
			agreedLen = matchLen;
			if (agreedLen === 0) break;
		}
		// Extend committed only when the new agreement PRESERVES the already
		// committed words — a longer agreement that disagrees inside the
		// committed prefix must not rewrite it (once committed, never
		// retracted; the hypotheses will converge and extend later).
		if (agreedLen > this.committed.length) {
			const candidate = first.slice(0, agreedLen);
			const preservesCommitted = this.committed.every(
				(word, i) => candidate[i] === word,
			);
			if (preservesCommitted) {
				this.committed = candidate;
			}
		}
		return this.committed;
	}

	/** Clear all state. Call at utterance boundaries. */
	reset(): void {
		this.window = [];
		this.committed = [];
	}

	/** The current committed stable word list (read-only view). */
	getCommitted(): string[] {
		return this.committed;
	}
}

/** Available transcription drive modes. */
export type StreamingPipelineMode = "streaming" | "batch";

/**
 * `ELIZA_VOICE_STREAMING_ASR` — the streaming-ASR kill switch. Default ON:
 * when the fused build advertises a working streaming decoder it is used
 * (with partial stabilization). Set `0` / `false` / `off` / `no` to pin the
 * interim batch adapter.
 */
export function readStreamingAsrEnabledFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env.ELIZA_VOICE_STREAMING_ASR?.trim().toLowerCase();
	if (!raw) return true;
	return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export interface PickStreamingModeArgs {
	/** True only when the loaded fused library advertises a working streaming decoder. */
	ffiSupportsStreaming: boolean;
	/** True only when the bundled ASR model is present on disk. */
	asrBundlePresent: boolean;
	/** `readStreamingAsrEnabledFromEnv()` at the bridge — default ON. */
	enableStreaming: boolean;
}

/**
 * Choose the transcription drive mode. Streaming is selected only when:
 *   - the loaded fused library advertises a working streaming decoder
 *     (`asr_stream_supported() === 1`), AND
 *   - the bundled ASR model is present, AND
 *   - the engine bridge has opted in via `enableStreaming`.
 *
 * Any other combination falls back to the existing batch path
 * (`VoicePipeline.transcribeAll`).
 */
export function pickStreamingMode(
	args: PickStreamingModeArgs,
): StreamingPipelineMode {
	if (!args.enableStreaming) return "batch";
	if (!args.ffiSupportsStreaming) return "batch";
	if (!args.asrBundlePresent) return "batch";
	return "streaming";
}

/* ==================================================================== *
 * Word-agreement gate — shared partial-stabilization transform.
 * ==================================================================== */

/** Whitespace word split. Keeps punctuation attached to its word. */
function splitWords(text: string): string[] {
	const trimmed = text.trim();
	return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/**
 * Applies word-level LocalAgreement-n to a stream of raw `partial`
 * hypotheses. `transform()` returns a committed-prefix update when the
 * agreed prefix grew, `null` to suppress (no growth — downstream already
 * saw everything committed). The committed prefix is monotonically
 * non-decreasing; a word, once surfaced, is never retracted. Token ids are
 * dropped from stabilized partials (they describe the raw hypothesis, not
 * the committed prefix); the authoritative `final` keeps its ids.
 */
export class WordAgreementGate {
	private readonly buffer: LocalAgreementBuffer;
	private surfacedWordCount = 0;

	constructor(agreementCount = 2) {
		this.buffer = new LocalAgreementBuffer(agreementCount);
	}

	transform(update: TranscriptUpdate): TranscriptUpdate | null {
		const committed = this.buffer.stable(splitWords(update.partial));
		if (committed.length <= this.surfacedWordCount) return null;
		this.surfacedWordCount = committed.length;
		const { tokens: _tokens, ...rest } = update;
		return { ...rest, partial: committed.join(" "), isFinal: false };
	}

	/** The committed stable word list (read-only view). */
	committedWords(): ReadonlyArray<string> {
		return this.buffer.getCommitted();
	}

	/** Clear all state. Call at utterance boundaries. */
	reset(): void {
		this.buffer.reset();
		this.surfacedWordCount = 0;
	}
}

/**
 * `StreamingTranscriber` decorator that stabilizes `partial` events through
 * a `WordAgreementGate` before its own subscribers see them. The engine
 * bridge wraps the fused streaming transcriber with this in streaming mode,
 * so the turn controller's existing subscription observes only monotonic
 * committed-prefix partials — no turn-controller edits needed.
 *
 * Event contract:
 *   - `partial` — emitted only when the committed prefix grows, carrying the
 *     committed text (raw-hypothesis metadata preserved, token ids dropped).
 *   - `words`  — emitted once per segment, the first time the COMMITTED
 *     prefix contains ≥1 word (the inner raw-hypothesis `words` event is
 *     withheld so barge-in word-confirm cannot fire on an unstable word).
 *   - `final`  — passed through unchanged (authoritative), resets the gate.
 */
export class StabilizedStreamingTranscriber implements StreamingTranscriber {
	private readonly listeners = new Set<TranscriberEventListener>();
	private readonly gate: WordAgreementGate;
	private wordsEmitted = false;
	private innerUnsub: (() => void) | null;

	constructor(
		readonly inner: StreamingTranscriber,
		agreementCount = 2,
	) {
		this.gate = new WordAgreementGate(agreementCount);
		this.innerUnsub = inner.on((event) => this.onInnerEvent(event));
	}

	feed(frame: PcmFrame): void {
		this.inner.feed(frame);
	}

	flush(): Promise<TranscriptUpdate> {
		return this.inner.flush();
	}

	on(listener: TranscriberEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.innerUnsub?.();
		this.innerUnsub = null;
		this.listeners.clear();
		this.inner.dispose();
	}

	private onInnerEvent(event: TranscriberEvent): void {
		switch (event.kind) {
			case "partial": {
				const update = this.gate.transform(event.update);
				if (!update) return;
				this.emit({ kind: "partial", update });
				if (!this.wordsEmitted) {
					const words = this.gate.committedWords();
					if (words.length > 0) {
						this.wordsEmitted = true;
						this.emit({ kind: "words", words: [...words] });
					}
				}
				return;
			}
			case "words":
				// Withheld: derived from the raw hypothesis. The stabilized
				// `words` event above replaces it once the prefix commits.
				return;
			case "final":
				this.gate.reset();
				this.wordsEmitted = false;
				this.emit(event);
				return;
		}
	}

	private emit(event: TranscriberEvent): void {
		for (const l of this.listeners) l(event);
	}
}

export interface StreamingAsrFeederEvents {
	/**
	 * Called when the segment's stabilized transcript grows, BEFORE the
	 * segment is finalized. Every raw hypothesis passes through a
	 * word-level `WordAgreementGate` (LocalAgreement-2) first, so this
	 * only ever carries a monotonically growing committed prefix — a word,
	 * once delivered, is never retracted. When the transcriber is already
	 * a `StabilizedStreamingTranscriber` the feeder forwards its (already
	 * stabilized) partials as-is rather than double-gating.
	 */
	onPartial?(update: TranscriptUpdate): void;
	/**
	 * Called the first time ≥1 COMMITTED word is recognized in the segment.
	 * Wired into the turn controller's word-confirm gate so the agent
	 * only barge-in-cancels on real, stable speech — not a blip or an
	 * unconfirmed first hypothesis.
	 */
	onWords?(words: ReadonlyArray<string>): void;
	/**
	 * Called once, after `finalize()` returns, with the final transcript
	 * split into contiguous text tokens (`splitTranscriptToTokens`). The
	 * batch path delivers the same shape via `transcribeAll`, so the
	 * downstream drafter/verifier loop sees an identical signal.
	 */
	onFinalTokens?(
		tokens: ReadonlyArray<TextToken>,
		final: TranscriptUpdate,
	): void;
}

/**
 * Drives a `StreamingTranscriber` chunk-by-chunk on behalf of the engine
 * bridge / turn controller. One instance per active speech segment;
 * `finalize()` returns the final transcript and the feeder is disposed.
 *
 * Construction takes a `StreamingTranscriber` (already constructed via
 * `createStreamingTranscriber` with the same options used for batch).
 * The feeder does NOT own the transcriber's lifecycle — disposal still
 * runs through the engine bridge so the same path is used when the
 * batch fallback is taken.
 */
export class StreamingAsrFeeder {
	private readonly transcriber: StreamingTranscriber;
	private readonly events: StreamingAsrFeederEvents;
	/** Non-null unless the transcriber is already stabilized upstream. */
	private readonly gate: WordAgreementGate | null;
	private wordsAnnounced = false;
	private latestPartial: TranscriptUpdate | null = null;
	private finalized = false;
	private unsubscribe: (() => void) | null = null;

	constructor(args: {
		transcriber: StreamingTranscriber;
		events?: StreamingAsrFeederEvents;
	}) {
		this.transcriber = args.transcriber;
		this.events = args.events ?? {};
		// One stabilization point per stream: when the bridge already wrapped
		// the transcriber, its partials are committed prefixes — re-gating
		// them would only add a hypothesis of lag.
		this.gate =
			args.transcriber instanceof StabilizedStreamingTranscriber
				? null
				: new WordAgreementGate();
		this.unsubscribe = this.transcriber.on((event) => {
			switch (event.kind) {
				case "partial": {
					const update = this.gate
						? this.gate.transform(event.update)
						: event.update;
					if (!update) break;
					this.latestPartial = update;
					this.events.onPartial?.(update);
					if (this.gate && !this.wordsAnnounced) {
						const words = this.gate.committedWords();
						if (words.length > 0) {
							this.wordsAnnounced = true;
							this.events.onWords?.([...words]);
						}
					}
					break;
				}
				case "words":
					// With a local gate the raw-hypothesis `words` event is
					// withheld — the committed-prefix announcement above
					// replaces it. Already-stabilized streams forward theirs.
					if (!this.gate) this.events.onWords?.(event.words);
					break;
				case "final":
					// Final events are surfaced via `finalize()`'s return value so
					// the caller has a single point of truth. We do not re-emit
					// them here.
					break;
			}
		});
	}

	/**
	 * Feed one PCM frame as it arrives from the mic / connector. Drops
	 * frames received after `finalize()` (the segment is over).
	 */
	feedFrame(frame: PcmFrame): void {
		if (this.finalized) return;
		this.transcriber.feed(frame);
	}

	/**
	 * Force-finalize on `speech-end`. Resolves with the final transcript
	 * and emits `onFinalTokens` so the caller can seed the drafter /
	 * verifier loop without re-running the surface split itself.
	 *
	 * Calling `finalize()` twice is a hard error — the segment is over.
	 */
	async finalize(): Promise<TranscriptUpdate> {
		if (this.finalized) {
			throw new Error(
				"[streaming-asr] finalize() called twice on the same feeder",
			);
		}
		this.finalized = true;
		const final = await this.transcriber.flush();
		const tokens = splitTranscriptToTokens(final.partial, 0, final.tokens);
		this.events.onFinalTokens?.(tokens, final);
		return final;
	}

	/** The most recent stabilized `partial`, or `null` until the first prefix commits. */
	getLatestPartial(): TranscriptUpdate | null {
		return this.latestPartial;
	}

	/** Detach the transcriber subscription. Does NOT dispose the transcriber itself. */
	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
}
