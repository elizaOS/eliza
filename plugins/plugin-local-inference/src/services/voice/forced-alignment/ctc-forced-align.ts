/**
 * CTC forced alignment — the true-timing core (#8789 transcripts).
 *
 * Given (a) frame-level emission log-probabilities from a CTC acoustic model and
 * (b) the KNOWN transcript token sequence, find the single most-likely monotonic
 * alignment of the tokens to audio frames via Viterbi over the blank-interleaved
 * target, then collapse to a per-word `[startMs,endMs]`. This is the standard
 * CTC `forced_align` (the same algorithm torchaudio/whisperX use), and it is the
 * only part of "true + local" word timing that is pure + deterministic: it needs
 * NO model to TEST, only an emission matrix.
 *
 * The matrix itself comes from a CTC acoustic model (audio → per-frame
 * char/phoneme logits) — see {@link CtcEmissionProvider}. That model is the
 * native/gated dependency (no local CTC inference path exists since ONNX was
 * removed); when it is absent, alignment yields no words and the player falls
 * back to segment-level highlighting.
 */

import type { TranscriptWord } from "@elizaos/shared/transcripts";

const NEG_INF = Number.NEGATIVE_INFINITY;

/** Frame-level emission log-probabilities from a CTC acoustic model. */
export interface CtcEmissions {
	/** `[numFrames][vocabSize]` natural-log probabilities per frame. */
	logProbs: ReadonlyArray<ReadonlyArray<number>>;
	/** Duration of one frame in ms (the acoustic-model stride, e.g. 20ms). */
	frameDurationMs: number;
	/** Blank token id in the vocab (default 0). */
	blank?: number;
}

/** One aligned target token with its inclusive audio-frame span + confidence. */
export interface CtcAlignToken {
	token: number;
	startFrame: number;
	/** Inclusive last frame. */
	endFrame: number;
	/** Mean per-frame emission log-prob over the span (alignment confidence). */
	score: number;
}

export interface CtcAlignResult {
	tokens: CtcAlignToken[];
}

/**
 * Viterbi CTC forced alignment of `targets` to `emissions`. Returns each target
 * token's audio-frame span. Empty when alignment is impossible (no frames, no
 * targets, or fewer frames than tokens).
 */
export function ctcForcedAlign(
	emissions: CtcEmissions,
	targets: ReadonlyArray<number>,
): CtcAlignResult {
	const blank = emissions.blank ?? 0;
	const logProbs = emissions.logProbs;
	const T = logProbs.length;
	const L = targets.length;
	// A monotonic path must visit each token at least one frame.
	if (T === 0 || L === 0 || T < L) return { tokens: [] };

	// Blank-interleaved extended sequence: [blank, t0, blank, t1, …, t_{L-1}, blank].
	const S = 2 * L + 1;
	const ext = new Array<number>(S);
	for (let i = 0; i < L; i++) {
		ext[2 * i] = blank;
		ext[2 * i + 1] = targets[i];
	}
	ext[S - 1] = blank;

	// backptr[t][s] ∈ {0=stay(s), 1=from s-1, 2=skip from s-2}.
	const backptr: Int8Array[] = new Array(T);
	let prev = new Float64Array(S).fill(NEG_INF);
	prev[0] = logProbs[0][ext[0]];
	if (S > 1) prev[1] = logProbs[0][ext[1]];
	backptr[0] = new Int8Array(S);

	for (let t = 1; t < T; t++) {
		const cur = new Float64Array(S).fill(NEG_INF);
		const bp = new Int8Array(S);
		const emit = logProbs[t];
		for (let s = 0; s < S; s++) {
			let best = prev[s]; // stay
			let arg = 0;
			if (s >= 1 && prev[s - 1] > best) {
				best = prev[s - 1];
				arg = 1;
			}
			// Skip the blank between two DIFFERENT tokens (a blank is mandatory
			// only between two identical tokens, so the skip is disallowed there).
			if (
				s >= 2 &&
				ext[s] !== blank &&
				ext[s] !== ext[s - 2] &&
				prev[s - 2] > best
			) {
				best = prev[s - 2];
				arg = 2;
			}
			if (best === NEG_INF) continue;
			cur[s] = best + emit[ext[s]];
			bp[s] = arg;
		}
		prev = cur;
		backptr[t] = bp;
	}

	// Terminal: the last token (S-2) or the trailing blank (S-1).
	let s = S - 1;
	if (S >= 2 && prev[S - 2] > prev[S - 1]) s = S - 2;
	if (prev[s] === NEG_INF) return { tokens: [] };

	// Backtrace → per-frame ext position.
	const path = new Int32Array(T);
	for (let t = T - 1; t >= 0; t--) {
		path[t] = s;
		if (t > 0) s -= backptr[t][s];
	}

	// Collapse: token i lives at ext position 2i+1; its frames are contiguous
	// because the Viterbi path is monotonic in position.
	const tokens: CtcAlignToken[] = [];
	for (let i = 0; i < L; i++) {
		const pos = 2 * i + 1;
		let start = -1;
		let end = -1;
		let scoreSum = 0;
		for (let t = 0; t < T; t++) {
			if (path[t] === pos) {
				if (start === -1) start = t;
				end = t;
				scoreSum += logProbs[t][ext[pos]];
			}
		}
		if (start === -1) {
			// Defensive: a token with no frames (shouldn't occur for T≥L). Pin a
			// zero-width span at the previous token's end so ordering holds.
			const at = tokens.length > 0 ? tokens[tokens.length - 1].endFrame : 0;
			tokens.push({
				token: targets[i],
				startFrame: at,
				endFrame: at,
				score: NEG_INF,
			});
			continue;
		}
		tokens.push({
			token: targets[i],
			startFrame: start,
			endFrame: end,
			score: scoreSum / (end - start + 1),
		});
	}
	return { tokens };
}

/** Inputs for {@link alignWords}: a tokenized transcript + its emissions. */
export interface AlignWordsInput {
	emissions: CtcEmissions;
	/** Target token ids (the transcript mapped to the acoustic-model vocab). */
	targets: ReadonlyArray<number>;
	/** Word index each target token belongs to (length === targets.length). */
	wordOfToken: ReadonlyArray<number>;
	/** Word texts; the array index equals the `wordOfToken` value. */
	words: ReadonlyArray<string>;
	/** Ms added to every timing (the segment's start within the recording). */
	offsetMs?: number;
}

function meanLogProbToConfidence(meanLogProb: number): number | undefined {
	if (!Number.isFinite(meanLogProb)) return undefined;
	return Math.min(1, Math.max(0, Math.exp(meanLogProb)));
}

/**
 * Forced-align a tokenized transcript to its emissions and group the per-token
 * frame spans into per-word `[startMs,endMs]` (the {@link TranscriptWord} shape
 * the player highlights against). Returns `[]` when alignment is impossible.
 */
export function alignWords(input: AlignWordsInput): TranscriptWord[] {
	const { emissions, targets, wordOfToken, words, offsetMs = 0 } = input;
	const { tokens } = ctcForcedAlign(emissions, targets);
	if (tokens.length === 0) return [];
	const frameMs = emissions.frameDurationMs;

	const spans = new Map<
		number,
		{ start: number; end: number; scoreSum: number; n: number }
	>();
	tokens.forEach((tok, i) => {
		const w = wordOfToken[i];
		if (w === undefined) return;
		const startMs = tok.startFrame * frameMs;
		const endMs = (tok.endFrame + 1) * frameMs;
		const span = spans.get(w);
		if (!span) {
			spans.set(w, { start: startMs, end: endMs, scoreSum: tok.score, n: 1 });
		} else {
			span.start = Math.min(span.start, startMs);
			span.end = Math.max(span.end, endMs);
			span.scoreSum += tok.score;
			span.n += 1;
		}
	});

	const out: TranscriptWord[] = [];
	for (let w = 0; w < words.length; w++) {
		const span = spans.get(w);
		if (!span) continue;
		const confidence = meanLogProbToConfidence(span.scoreSum / span.n);
		out.push({
			text: words[w],
			startMs: Math.round(span.start + offsetMs),
			endMs: Math.round(span.end + offsetMs),
			...(confidence === undefined ? {} : { confidence }),
		});
	}
	return out;
}

/**
 * Produces CTC frame emissions for an audio buffer — implemented by the native
 * CTC acoustic model (the gated dependency). `tokenize` maps a transcript into
 * the model's target vocab + the word grouping the aligner needs.
 */
export interface CtcEmissionProvider {
	/** True when a local CTC acoustic model is loaded and can emit frame logits. */
	available(): boolean;
	/** Map a transcript into target token ids + per-token word index + word texts. */
	tokenize(text: string): {
		targets: number[];
		wordOfToken: number[];
		words: string[];
	};
	/** Run the acoustic model over mono PCM (`[-1,1]`) → frame emissions. */
	emit(pcm: Float32Array, sampleRate: number): Promise<CtcEmissions>;
}

/**
 * Align one transcript segment's audio to its text, returning word timings.
 * Returns `[]` (the player degrades to segment-level highlight) whenever the
 * acoustic model is unavailable or the text has no alignable tokens.
 */
export async function alignTranscriptSegment(
	provider: CtcEmissionProvider,
	pcm: Float32Array,
	sampleRate: number,
	text: string,
	offsetMs = 0,
): Promise<TranscriptWord[]> {
	if (!provider.available()) return [];
	const { targets, wordOfToken, words } = provider.tokenize(text);
	if (targets.length === 0) return [];
	const emissions = await provider.emit(pcm, sampleRate);
	return alignWords({ emissions, targets, wordOfToken, words, offsetMs });
}
