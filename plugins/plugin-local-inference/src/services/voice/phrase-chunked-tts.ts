/** Synthesizes phrases concurrently and delivers audio in source order. */
import { PhraseChunker } from "./phrase-chunker";
import type { Phrase, PhraseChunkerConfig } from "./types";

export interface PhraseChunkedTtsOptions {
	chunker?: PhraseChunkerConfig;
	clock?: () => number;
	onAudio?: (phrase: Phrase, audio: unknown) => void | Promise<void>;
	onPhraseEmit?: (phrase: Phrase) => void;
	/** Fail on finish by default; callers can explicitly handle and skip a phrase. */
	onTtsError?: (phrase: Phrase, error: unknown) => "swallow" | "fail";
}

export type PhraseTtsHandler = (
	text: string,
	signal: AbortSignal,
) => unknown | Promise<unknown>;

export class PhraseChunkedTts {
	private readonly chunker: PhraseChunker;
	private readonly clock: () => number;
	private readonly abort = new AbortController();
	private tokenIndex = 0;
	private delivery: Promise<void> = Promise.resolve();
	private finishing: Promise<void> | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private firstError: unknown;
	private failed = false;
	private closed = false;

	constructor(
		private readonly tts: PhraseTtsHandler,
		private readonly options: PhraseChunkedTtsOptions = {},
	) {
		this.clock = options.clock ?? (() => performance.now());
		this.chunker = new PhraseChunker(
			options.chunker ?? { chunkOn: "punctuation" },
			null,
			this.clock,
		);
	}

	push(text: string): void {
		if (this.closed)
			throw new Error("PhraseChunkedTts.push() called after finish or cancel");
		if (!text) return;
		const phrase = this.chunker.push({
			index: this.tokenIndex++,
			text,
			acceptedAt: this.clock(),
		});
		if (phrase) this.dispatch(phrase);
		this.scheduleFlush();
	}

	/** All callers await the same drain, including callers arriving during delivery. */
	finish(): Promise<void> {
		if (this.finishing) return this.finishing;
		this.closed = true;
		this.clearTimer();
		if (!this.abort.signal.aborted) {
			const tail = this.chunker.flushPending();
			if (tail) this.dispatch(tail);
		}
		this.finishing = this.delivery.then(() => {
			if (this.failed) throw this.firstError;
		});
		return this.finishing;
	}

	/** Suppress pending delivery and ask providers to abort synthesis. */
	cancel(): void {
		this.closed = true;
		this.abort.abort();
		this.clearTimer();
		this.chunker.reset();
	}

	private recordError(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.firstError = error;
	}

	private dispatch(phrase: Phrase): void {
		// Observe failures immediately, even when an earlier phrase is still pending.
		const synthesis = Promise.resolve()
			.then(() => {
				if (this.abort.signal.aborted) return undefined;
				this.options.onPhraseEmit?.(phrase);
				return this.tts(phrase.text, this.abort.signal);
			})
			.then(
				(audio) => ({ ok: true as const, audio }),
				(error) => ({ ok: false as const, error }),
			);
		this.delivery = this.delivery
			.then(async () => {
				const result = await synthesis;
				if (this.abort.signal.aborted) return;
				if (!result.ok) throw result.error;
				await this.options.onAudio?.(phrase, result.audio);
			})
			.catch((error) => {
				try {
					if (this.options.onTtsError?.(phrase, error) !== "swallow")
						this.recordError(error);
				} catch (policyError) {
					this.recordError(policyError);
				}
			});
	}

	private clearTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private scheduleFlush(): void {
		this.clearTimer();
		const remaining = this.chunker.msUntilTimeBudget();
		if (!Number.isFinite(remaining)) return;
		if (remaining <= 0) {
			const phrase = this.chunker.flushIfTimeBudgetExceeded();
			if (phrase) this.dispatch(phrase);
			return;
		}
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				if (this.closed) return;
				const phrase = this.chunker.flushIfTimeBudgetExceeded();
				if (phrase) this.dispatch(phrase);
				// Timers may fire slightly early; retain the pending phrase's deadline.
				this.scheduleFlush();
			},
			Math.max(1, Math.ceil(remaining)),
		);
		this.timer.unref?.();
	}
}

export async function speakStreamingText(
	source: AsyncIterable<string>,
	tts: PhraseTtsHandler,
	options: PhraseChunkedTtsOptions = {},
): Promise<void> {
	const pipe = new PhraseChunkedTts(tts, options);
	try {
		for await (const text of source) pipe.push(text);
		await pipe.finish();
	} catch (error) {
		pipe.cancel();
		// Every synthesis/delivery rejection is already observed by the pipeline.
		// Preserve the source error instead of flushing an incomplete response.
		throw error;
	}
}
