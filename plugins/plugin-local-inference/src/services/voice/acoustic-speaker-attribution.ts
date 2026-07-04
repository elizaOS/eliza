/**
 * Model-free acoustic speaker attribution for the Voice Workbench (#9147, #9427).
 *
 * The DER gate must score a label derived from the AUDIO against ground truth,
 * never ground truth against itself — a tautology that can never fail (#9427).
 * This module derives that speaker label from the audio and nothing else.
 *
 *   extractTimbreEmbedding  — a deterministic mean-MFCC voice embedding (the
 *                             speaker's timbre), via a dependency-free FFT +
 *                             mel filterbank + DCT. No model, no network.
 *   OnlineSpeakerClusterer  — blind clustering: each turn is matched to the
 *                             nearest running speaker centroid by cosine and
 *                             takes that cluster's id, or seeds a new cluster.
 *                             It never sees ground truth, so a wrong cluster
 *                             surfaces as real Diarization Error Rate.
 *   selfVoiceSimilarity     — cosine of a turn against the agent's own TTS-voice
 *                             imprint — the acoustic self-echo signal that used
 *                             to be a hardcoded `0.9`.
 *
 * Pure + deterministic (no `Date.now`/`Math.random`), so the gate is byte-stable
 * in CI yet genuinely able to fail on a misattribution.
 */

import {
	AGENT_VOICE_TIMBRE,
	makeSpeechWithSilenceFixture,
} from "./__test-helpers__/synthetic-speech";
import {
	cosineSimilarity,
	normalizeVoiceEmbedding,
	updateVoiceImprintCentroid,
} from "./speaker-imprint";

const FFT_SIZE = 512;
const FRAME_LEN = 400; // 25 ms @ 16 kHz
const HOP = 160; // 10 ms @ 16 kHz
const N_MELS = 26;
const MEL_FMIN_HZ = 80;
/** MFCC coefficients kept (1..N_CEPS); c0 is dropped — it is just frame energy. */
const N_CEPS = 13;

/**
 * Cosine at/above which a turn joins an existing speaker cluster. Tuned so that
 * the same synthetic speaker (even degraded by the corpus's room noise/reverb)
 * stays in one cluster, while two distinct timbres split — see
 * `acoustic-speaker-attribution.test.ts`.
 */
export const DEFAULT_SPEAKER_CLUSTER_THRESHOLD = 0.5;

/** In-place iterative radix-2 Cooley–Tukey FFT (size must be a power of two). */
function fftRadix2(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			const tr = re[i];
			re[i] = re[j];
			re[j] = tr;
			const ti = im[i];
			im[i] = im[j];
			im[j] = ti;
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const wRe = Math.cos(ang);
		const wIm = Math.sin(ang);
		const half = len >> 1;
		for (let i = 0; i < n; i += len) {
			let curRe = 1;
			let curIm = 0;
			for (let k = 0; k < half; k++) {
				const aRe = re[i + k];
				const aIm = im[i + k];
				const idx = i + k + half;
				const bRe = re[idx] * curRe - im[idx] * curIm;
				const bIm = re[idx] * curIm + im[idx] * curRe;
				re[i + k] = aRe + bRe;
				im[i + k] = aIm + bIm;
				re[idx] = aRe - bRe;
				im[idx] = aIm - bIm;
				const nextRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nextRe;
			}
		}
	}
}

function hzToMel(hz: number): number {
	return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
	return 700 * (10 ** (mel / 2595) - 1);
}

let hannCache: Float64Array | null = null;
function hannWindow(): Float64Array {
	if (hannCache) return hannCache;
	const w = new Float64Array(FRAME_LEN);
	for (let i = 0; i < FRAME_LEN; i++) {
		w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1));
	}
	hannCache = w;
	return w;
}

let melCache: { sampleRate: number; filters: Float64Array[] } | null = null;
/** Triangular mel filterbank over the `FFT_SIZE/2 + 1` magnitude bins. */
function melFilterbank(sampleRate: number): Float64Array[] {
	if (melCache && melCache.sampleRate === sampleRate) return melCache.filters;
	const nBins = FFT_SIZE / 2 + 1;
	const melMin = hzToMel(MEL_FMIN_HZ);
	const melMax = hzToMel(sampleRate / 2);
	const edges: number[] = [];
	for (let i = 0; i < N_MELS + 2; i++) {
		edges.push(melToHz(melMin + ((melMax - melMin) * i) / (N_MELS + 1)));
	}
	const binHz = (b: number) => (b * sampleRate) / FFT_SIZE;
	const filters: Float64Array[] = [];
	for (let m = 1; m <= N_MELS; m++) {
		const lo = edges[m - 1];
		const ctr = edges[m];
		const hi = edges[m + 1];
		const f = new Float64Array(nBins);
		for (let b = 0; b < nBins; b++) {
			const hz = binHz(b);
			if (hz >= lo && hz <= ctr && ctr > lo) f[b] = (hz - lo) / (ctr - lo);
			else if (hz > ctr && hz <= hi && hi > ctr) f[b] = (hi - hz) / (hi - ctr);
		}
		filters.push(f);
	}
	melCache = { sampleRate, filters };
	return filters;
}

/** Sinusoidal cepstral lifter weight; L=22 is the long-standing HTK default. */
const CEPSTRAL_LIFTER_L = 22;
let lifterCache: number[] | null = null;
function cepstralLifter(): number[] {
	if (lifterCache) return lifterCache;
	const w: number[] = [];
	for (let k = 1; k <= N_CEPS; k++) {
		w.push(
			1 + (CEPSTRAL_LIFTER_L / 2) * Math.sin((Math.PI * k) / CEPSTRAL_LIFTER_L),
		);
	}
	lifterCache = w;
	return w;
}

let dctCache: Float64Array[] | null = null;
/** DCT-II rows for cepstral coefficients 1..N_CEPS (c0 omitted). */
function dctRows(): Float64Array[] {
	if (dctCache) return dctCache;
	const rows: Float64Array[] = [];
	for (let k = 1; k <= N_CEPS; k++) {
		const row = new Float64Array(N_MELS);
		for (let n = 0; n < N_MELS; n++) {
			row[n] = Math.cos((Math.PI * k * (n + 0.5)) / N_MELS);
		}
		rows.push(row);
	}
	dctCache = rows;
	return rows;
}

/**
 * Mean-MFCC voice embedding of a mono PCM clip: the average cepstrum over its
 * voiced frames, L2-normalized. Captures vocal-tract timbre (the speaker), not
 * the words. Returns a zero vector for silence / too-short audio.
 */
export function extractTimbreEmbedding(
	pcm: Float32Array,
	sampleRate: number,
): number[] {
	const filters = melFilterbank(sampleRate);
	const dct = dctRows();
	const hann = hannWindow();
	const nBins = FFT_SIZE / 2 + 1;

	// Pass 1: per-frame energy, to keep only voiced frames (relative to the peak).
	const starts: number[] = [];
	const energies: number[] = [];
	let maxEnergy = 0;
	for (let s = 0; s + FRAME_LEN <= pcm.length; s += HOP) {
		let e = 0;
		for (let i = 0; i < FRAME_LEN; i++) {
			const v = pcm[s + i];
			e += v * v;
		}
		starts.push(s);
		energies.push(e);
		if (e > maxEnergy) maxEnergy = e;
	}
	if (maxEnergy <= 1e-9) return new Array<number>(N_CEPS).fill(0);
	const floor = maxEnergy * 0.1;

	const re = new Float64Array(FFT_SIZE);
	const im = new Float64Array(FFT_SIZE);
	const accum = new Float64Array(N_CEPS);
	let voiced = 0;
	for (let fi = 0; fi < starts.length; fi++) {
		if (energies[fi] < floor) continue;
		const s = starts[fi];
		re.fill(0);
		im.fill(0);
		for (let i = 0; i < FRAME_LEN; i++) re[i] = pcm[s + i] * hann[i];
		fftRadix2(re, im);
		// Log mel-band energies.
		const logMel = new Float64Array(N_MELS);
		for (let m = 0; m < N_MELS; m++) {
			const filt = filters[m];
			let acc = 0;
			for (let b = 0; b < nBins; b++) {
				const power = re[b] * re[b] + im[b] * im[b];
				acc += power * filt[b];
			}
			logMel[m] = Math.log(acc + 1e-10);
		}
		// DCT-II → cepstrum (coefficients 1..N_CEPS).
		for (let k = 0; k < N_CEPS; k++) {
			const row = dct[k];
			let c = 0;
			for (let n = 0; n < N_MELS; n++) c += logMel[n] * row[n];
			accum[k] += c;
		}
		voiced += 1;
	}
	if (voiced === 0) return new Array<number>(N_CEPS).fill(0);
	const lifter = cepstralLifter();
	const mean = new Array<number>(N_CEPS);
	// Sinusoidal liftering de-emphasizes the dominant low-order cepstral tilt (the
	// glottal source slope, shared by every voice) and emphasizes the mid/high
	// coefficients that carry the formant pattern — i.e. the speaker signal.
	for (let k = 0; k < N_CEPS; k++) mean[k] = (accum[k] / voiced) * lifter[k];
	return normalizeVoiceEmbedding(mean);
}

function isZeroVector(v: ArrayLike<number>): boolean {
	for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
	return true;
}

interface SpeakerCluster {
	id: string;
	centroid: number[];
	count: number;
}

/**
 * Blind online speaker clustering. Each turn embedding is matched to the nearest
 * running centroid; if the best cosine clears the threshold it joins that
 * cluster (and updates its centroid), otherwise it seeds a new one. The cluster
 * ids it returns (`spk0`, `spk1`, …) are label-agnostic — DER maps them onto the
 * ground-truth speakers optimally — so the clusterer never needs (and never
 * sees) the true labels.
 */
export class OnlineSpeakerClusterer {
	private readonly clusters: SpeakerCluster[] = [];
	private readonly threshold: number;

	constructor(threshold: number = DEFAULT_SPEAKER_CLUSTER_THRESHOLD) {
		this.threshold = threshold;
	}

	/** Assign an embedding to a cluster id, or `null` if it carries no signal. */
	assign(embedding: ArrayLike<number>): string | null {
		if (embedding.length === 0 || isZeroVector(embedding)) return null;
		const emb = normalizeVoiceEmbedding(embedding);
		let best: SpeakerCluster | null = null;
		let bestSim = Number.NEGATIVE_INFINITY;
		for (const cluster of this.clusters) {
			const sim = cosineSimilarity(emb, cluster.centroid);
			if (sim > bestSim) {
				bestSim = sim;
				best = cluster;
			}
		}
		if (best && bestSim >= this.threshold) {
			const updated = updateVoiceImprintCentroid({
				centroidEmbedding: best.centroid,
				sampleCount: best.count,
				observationEmbedding: emb,
			});
			best.centroid = updated.centroidEmbedding;
			best.count = updated.sampleCount;
			return best.id;
		}
		const id = `spk${this.clusters.length}`;
		this.clusters.push({ id, centroid: emb, count: 1 });
		return id;
	}

	/** Embed `pcm` and assign it to a cluster id (or `null` for silence). */
	assignAudio(pcm: Float32Array, sampleRate: number): string | null {
		return this.assign(extractTimbreEmbedding(pcm, sampleRate));
	}
}

let agentVoiceCache: { sampleRate: number; embedding: number[] } | null = null;
/** The agent's own TTS-voice imprint embedding (memoized per sample rate). */
function agentVoiceEmbedding(sampleRate: number): number[] {
	if (agentVoiceCache && agentVoiceCache.sampleRate === sampleRate) {
		return agentVoiceCache.embedding;
	}
	const ref = makeSpeechWithSilenceFixture({
		sampleRate,
		leadSilenceSec: 0.05,
		speechSec: 1.5,
		tailSilenceSec: 0.05,
		seed: 0xa6e7,
		timbre: AGENT_VOICE_TIMBRE,
	});
	const embedding = extractTimbreEmbedding(ref.pcm, sampleRate);
	agentVoiceCache = { sampleRate, embedding };
	return embedding;
}

/**
 * Cosine similarity (clamped to 0..1) of a turn's audio against the agent's own
 * synthetic-voice imprint. High ⇒ the agent is hearing ITSELF (its TTS bled back
 * into the mic). This is the acoustic self-echo signal the respond-gate consumes
 * as `selfVoiceSimilarity` — a real measurement, not a constant.
 */
export function selfVoiceSimilarity(
	pcm: Float32Array,
	sampleRate: number,
): number {
	const emb = extractTimbreEmbedding(pcm, sampleRate);
	if (isZeroVector(emb)) return 0;
	return Math.max(0, cosineSimilarity(emb, agentVoiceEmbedding(sampleRate)));
}
