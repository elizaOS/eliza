/**
 * Pure helpers for the #10726 voice benchmark lanes (STT-quant WER/RTF,
 * noise-rejection WER-vs-SNR, speaker-isolation attribution). No I/O, no FFI —
 * everything here runs in the default vitest lane. The weights-touching flows
 * live in `scripts/stt-quant-bench-real.ts`, `scripts/noise-rejection-real.ts`
 * and `scripts/speaker-isolation-real.ts`.
 */

import { dbToGain, measureRms } from "./corpus-augment";

/**
 * Cosine distance (1 - cosine similarity), dimension-agnostic — unlike
 * `voiceSpeakerDistance` (encoder-ggml), which enforces the 256-d WeSpeaker
 * contract and would reject e.g. MFCC embeddings.
 */
export function cosineDistance(
	a: readonly number[],
	b: readonly number[],
): number {
	if (a.length !== b.length || a.length === 0) {
		throw new Error(
			`[bench-utils] cosineDistance dim mismatch (${a.length} vs ${b.length})`,
		);
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 1;
	return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** One fixed-transcript corpus utterance (reference text is the WER ground truth). */
export interface BenchCorpusEntry {
	id: string;
	text: string;
	voiceId: string;
}

/**
 * Fixed clean-speech corpus for the STT quality lanes. The reference texts are
 * the WER ground truth; audio is synthesized once with the shipped Kokoro TTS
 * and cached. Voices rotate so no single timbre dominates the aggregate WER.
 */
export const STT_BENCH_CORPUS: readonly BenchCorpusEntry[] = [
	{
		id: "utt-01",
		voiceId: "af_bella",
		text: "The quick brown fox jumps over the lazy dog near the river bank.",
	},
	{
		id: "utt-02",
		voiceId: "am_michael",
		text: "Please schedule a meeting with the design team for tomorrow afternoon.",
	},
	{
		id: "utt-03",
		voiceId: "bf_emma",
		text: "The weather forecast predicts light rain and cooler temperatures this weekend.",
	},
	{
		id: "utt-04",
		voiceId: "bm_george",
		text: "She placed the old photographs carefully inside the wooden box.",
	},
	{
		id: "utt-05",
		voiceId: "af_bella",
		text: "Our train departs from platform nine at half past seven.",
	},
	{
		id: "utt-06",
		voiceId: "am_michael",
		text: "The museum exhibit features paintings from the early modern period.",
	},
	{
		id: "utt-07",
		voiceId: "bf_emma",
		text: "He ordered a large coffee and a blueberry muffin for breakfast.",
	},
	{
		id: "utt-08",
		voiceId: "bm_george",
		text: "The engineers reviewed the bridge design before construction began.",
	},
	{
		id: "utt-09",
		voiceId: "af_bella",
		text: "A gentle breeze carried the scent of pine through the valley.",
	},
	{
		id: "utt-10",
		voiceId: "am_michael",
		text: "The library closes early on national holidays during the summer.",
	},
	{
		id: "utt-11",
		voiceId: "bf_emma",
		text: "Remember to water the plants and feed the cat before leaving.",
	},
	{
		id: "utt-12",
		voiceId: "bm_george",
		text: "The orchestra rehearsed the final movement twice before the concert.",
	},
];

/**
 * Competing-talker texts for the real-babble noise track. Voices are distinct
 * from the STT corpus voices so babble never shares a timbre with the target.
 */
export const BABBLE_CORPUS: readonly BenchCorpusEntry[] = [
	{
		id: "babble-01",
		voiceId: "af_nicole",
		text: "Meanwhile the committee discussed the annual budget and the upcoming election of new board members without reaching any firm conclusion.",
	},
	{
		id: "babble-02",
		voiceId: "am_adam",
		text: "Somebody mentioned that the restaurant on the corner serves excellent pasta and the service is usually quite fast on weekdays.",
	},
	{
		id: "babble-03",
		voiceId: "af_sarah",
		text: "The children played in the garden while their parents talked about holiday plans and the new school schedule.",
	},
];

/** Two-speaker dialogue for the speaker-isolation slice (A=af_bella, B=am_michael). */
export const TWO_SPEAKER_DIALOGUE: readonly (BenchCorpusEntry & {
	speaker: "A" | "B";
})[] = [
	{
		id: "turn-01",
		speaker: "A",
		voiceId: "af_bella",
		text: "Did you finish reading the report I sent you yesterday evening?",
	},
	{
		id: "turn-02",
		speaker: "B",
		voiceId: "am_michael",
		text: "Yes, I read it last night and left a few comments in the margins.",
	},
	{
		id: "turn-03",
		speaker: "A",
		voiceId: "af_bella",
		text: "Great, I will update the draft before the meeting on Thursday.",
	},
	{
		id: "turn-04",
		speaker: "B",
		voiceId: "am_michael",
		text: "Remember to include the revised numbers from the finance team.",
	},
	{
		id: "turn-05",
		speaker: "A",
		voiceId: "af_bella",
		text: "Those figures arrived this morning and they look much better now.",
	},
	{
		id: "turn-06",
		speaker: "B",
		voiceId: "am_michael",
		text: "Perfect, then we are ready to present the results on Friday.",
	},
	{
		id: "turn-07",
		speaker: "A",
		voiceId: "af_bella",
		text: "I will book the conference room for ten o'clock in the morning.",
	},
	{
		id: "turn-08",
		speaker: "B",
		voiceId: "am_michael",
		text: "Sounds good, send me the invite when everything is ready.",
	},
];

/**
 * Mix a real noise/babble track into clean speech at a target SNR.
 *
 * `addNoise` (corpus-augment) covers *generated* noise kinds; this covers a
 * supplied recording: the noise is tiled/truncated to the clean length, scaled
 * so `20*log10(cleanRms/noiseRms) === snrDb`, and added. Deterministic.
 */
export function mixAtSnr(
	clean: Float32Array,
	noise: Float32Array,
	snrDb: number,
): Float32Array {
	if (noise.length === 0) throw new Error("[bench-utils] empty noise track");
	const tiled = new Float32Array(clean.length);
	for (let i = 0; i < tiled.length; i++) tiled[i] = noise[i % noise.length];
	const cleanRms = measureRms(clean) || 1e-6;
	const noiseRms = measureRms(tiled) || 1e-6;
	const scale = cleanRms / dbToGain(snrDb) / noiseRms;
	const out = new Float32Array(clean.length);
	for (let i = 0; i < out.length; i++) out[i] = clean[i] + tiled[i] * scale;
	return out;
}

export interface WerAtSnr {
	snrDb: number;
	wer: number;
}

/**
 * Quasi-monotonicity check for a WER-vs-SNR curve: WER must not be more than
 * `tol` WORSE at a higher SNR than at the adjacent lower SNR (less noise must
 * not make recognition collapse). Returns human-readable violations; empty
 * array = curve is sane.
 */
export function quasiMonotonicViolations(
	points: readonly WerAtSnr[],
	tol: number,
): string[] {
	const sorted = [...points].sort((a, b) => a.snrDb - b.snrDb);
	const violations: string[] = [];
	for (let i = 1; i < sorted.length; i++) {
		const lo = sorted[i - 1];
		const hi = sorted[i];
		if (hi.wer > lo.wer + tol) {
			violations.push(
				`WER ${hi.wer.toFixed(3)} @ ${hi.snrDb}dB exceeds WER ${lo.wer.toFixed(3)} @ ${lo.snrDb}dB by more than tol=${tol}`,
			);
		}
	}
	return violations;
}

export interface TimelineTurn {
	speaker: string;
	pcm: Float32Array;
}

export interface SpeakerTimelineSegment {
	speaker: string;
	startMs: number;
	endMs: number;
}

export interface SpeakerTimeline {
	pcm: Float32Array;
	segments: SpeakerTimelineSegment[];
}

/** Concatenate speaker turns with silence gaps; ground-truth segments fall out of the construction. */
export function buildSpeakerTimeline(
	turns: readonly TimelineTurn[],
	sampleRate: number,
	gapMs: number,
): SpeakerTimeline {
	const gap = Math.round((gapMs / 1000) * sampleRate);
	const total =
		turns.reduce((acc, t) => acc + t.pcm.length, 0) + gap * (turns.length + 1);
	const pcm = new Float32Array(total);
	const segments: SpeakerTimelineSegment[] = [];
	let off = gap;
	for (const turn of turns) {
		pcm.set(turn.pcm, off);
		segments.push({
			speaker: turn.speaker,
			startMs: Math.round((off / sampleRate) * 1000),
			endMs: Math.round(((off + turn.pcm.length) / sampleRate) * 1000),
		});
		off += turn.pcm.length + gap;
	}
	return { pcm, segments };
}

export interface EmbeddedTurn {
	id: string;
	speaker: string;
	embedding: Float32Array | number[];
}

export interface AttributionScore {
	/** Turns scored (everything after the per-speaker enrollment turn). */
	scored: number;
	correct: number;
	/** correct / scored; 1 when nothing was scored (vacuous — check `scored`). */
	accuracy: number;
	/** Mean cosine distance to the SAME speaker's enrollment embedding. */
	intraMean: number;
	/** Mean cosine distance to the OTHER speakers' enrollment embeddings. */
	interMean: number;
	/** interMean - intraMean; positive = speakers are separable. */
	margin: number;
	perTurn: Array<{
		id: string;
		speaker: string;
		attributed: string;
		correct: boolean;
		distanceToOwn: number;
		distanceToNearestOther: number;
	}>;
}

/**
 * Enrollment-based attribution: the first turn of each speaker enrolls that
 * speaker; every later turn is attributed to the nearest enrollment by cosine
 * distance. This mirrors the product flow (owner enrolls once, later speech is
 * matched against stored profiles).
 */
export function attributeByEnrollment(
	turns: readonly EmbeddedTurn[],
): AttributionScore {
	const enrollment = new Map<string, number[]>();
	const scoredTurns: EmbeddedTurn[] = [];
	for (const turn of turns) {
		const emb = Array.from(turn.embedding);
		if (!enrollment.has(turn.speaker)) enrollment.set(turn.speaker, emb);
		else scoredTurns.push(turn);
	}
	if (enrollment.size < 2) {
		throw new Error(
			"[bench-utils] attributeByEnrollment needs at least two speakers",
		);
	}
	let correct = 0;
	const intra: number[] = [];
	const inter: number[] = [];
	const perTurn: AttributionScore["perTurn"] = [];
	for (const turn of scoredTurns) {
		const emb = Array.from(turn.embedding);
		let best: { speaker: string; distance: number } | null = null;
		let own = Number.NaN;
		let nearestOther = Number.POSITIVE_INFINITY;
		for (const [speaker, ref] of enrollment) {
			const d = cosineDistance(emb, ref);
			if (speaker === turn.speaker) {
				own = d;
				intra.push(d);
			} else {
				inter.push(d);
				if (d < nearestOther) nearestOther = d;
			}
			if (!best || d < best.distance) best = { speaker, distance: d };
		}
		const attributed = best?.speaker ?? "?";
		const ok = attributed === turn.speaker;
		if (ok) correct++;
		perTurn.push({
			id: turn.id,
			speaker: turn.speaker,
			attributed,
			correct: ok,
			distanceToOwn: own,
			distanceToNearestOther: nearestOther,
		});
	}
	const mean = (xs: number[]) =>
		xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
	const intraMean = mean(intra);
	const interMean = mean(inter);
	return {
		scored: scoredTurns.length,
		correct,
		accuracy: scoredTurns.length === 0 ? 1 : correct / scoredTurns.length,
		intraMean,
		interMean,
		margin: interMean - intraMean,
		perTurn,
	};
}
