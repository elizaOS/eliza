/**
 * Deterministic-ish speech-like audio generator for VAD/wake-word smoke
 * tests. Pure synthesis (glottal pulse train through a three-formant
 * resonator bank with a syllable-rate amplitude envelope and mild f0
 * jitter) — close enough to real speech in the time/frequency domain that
 * the Silero VAD reads it as speech, without shipping a recorded WAV.
 *
 * `silence + speech + silence` is the canonical smoke fixture: the VAD
 * should detect exactly one speech segment whose boundaries land inside
 * the voiced region, and `VadDetector` should drop the leading/trailing
 * silence windows from its speech-state timeline.
 */

export interface SpeechFixtureOptions {
	sampleRate?: number;
	/** Seconds of leading silence. */
	leadSilenceSec?: number;
	/** Seconds of synthesized speech. */
	speechSec?: number;
	/** Seconds of trailing silence. */
	tailSilenceSec?: number;
	/** Deterministic seed for the f0 jitter. */
	seed?: number;
	/**
	 * Per-speaker voice colour. Two speakers with different timbres have
	 * measurably different spectral envelopes, so an acoustic diarizer can tell
	 * them apart from the audio alone. Omit for the default (shared) voice — the
	 * VAD/wake-word smoke fixtures don't care who is speaking.
	 */
	timbre?: SpeakerTimbre;
}

/** A speaker's voice colour: fundamental frequency + vocal-tract formants. */
export interface SpeakerTimbre {
	/** Base fundamental frequency (Hz) — speaker pitch. */
	f0Hz: number;
	/** Three `[centerHz, bandwidthHz]` formants — the vocal-tract resonances. */
	formants: ReadonlyArray<readonly [number, number]>;
}

export interface SpeechFixture {
	pcm: Float32Array;
	sampleRate: number;
	speechStartSample: number;
	speechEndSample: number;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A three-formant resonator bank state. */
class FormantBank {
	private readonly r: number[];
	private readonly a1: number[];
	private readonly a2: number[];
	private readonly z1: number[];
	private readonly z2: number[];
	constructor(
		sampleRate: number,
		formants: ReadonlyArray<readonly [number, number]>,
	) {
		this.r = [];
		this.a1 = [];
		this.a2 = [];
		this.z1 = [];
		this.z2 = [];
		for (const [fc, bw] of formants) {
			const r = Math.exp((-Math.PI * bw) / sampleRate);
			const theta = (2 * Math.PI * fc) / sampleRate;
			this.r.push(r);
			this.a1.push(-2 * r * Math.cos(theta));
			this.a2.push(r * r);
			this.z1.push(0);
			this.z2.push(0);
		}
	}
	step(excitation: number): number {
		let v = 0;
		for (let k = 0; k < this.r.length; k++) {
			const y = excitation - this.a1[k] * this.z1[k] - this.a2[k] * this.z2[k];
			this.z2[k] = this.z1[k];
			this.z1[k] = y;
			v += y * (1 - k * 0.25);
		}
		return v;
	}
}

const DEFAULT_FORMANTS: ReadonlyArray<readonly [number, number]> = [
	[700, 80],
	[1220, 90],
	[2600, 120],
];

/** The shared (speaker-agnostic) voice used when no `timbre` is supplied. */
export const DEFAULT_SPEAKER_TIMBRE: SpeakerTimbre = {
	f0Hz: 110,
	formants: DEFAULT_FORMANTS,
};

/**
 * Deterministic, distinct voice colour for participant `index` of `count`
 * speakers in a scenario. The speakers are spread EVENLY across a wide
 * vocal-tract-length (formant-scaling) and pitch range, so every pair in a
 * scenario is acoustically far apart — a blind acoustic diarizer can split them
 * from the audio alone — while one participant always gets one timbre, so the
 * same speaker clusters together. Spreading by position (not by a label hash)
 * guarantees the separation; two labels could otherwise hash to near-identical
 * voices and merge.
 */
export function speakerTimbreForIndex(
	index: number,
	count: number,
): SpeakerTimbre {
	const frac = count <= 1 ? 0.5 : index / (count - 1); // 0..1
	// Vocal-tract scaling 0.72..1.32 (shorter tract → higher formants).
	const formantScale = 0.72 + frac * 0.6;
	// Alternate the second formant up/down so even adjacent slots differ in
	// formant PATTERN (F2 is the most speaker-discriminative resonance), not just
	// a global shift.
	const f2Bias = index % 2 === 0 ? 1.06 : 0.94;
	const formants = DEFAULT_FORMANTS.map(([fc, bw], i) => {
		const bias = i === 1 ? f2Bias : 1;
		return [fc * formantScale * bias, bw] as const;
	});
	// Pitch 98..202 Hz.
	const f0Hz = 98 + frac * 104;
	return { f0Hz, formants };
}

/**
 * The agent's own synthetic TTS voice — a fixed timbre, deliberately placed
 * outside the speaker-seed range so it is acoustically distinct from every
 * scenario participant. The corpus synthesizes agent-echo turns with this voice,
 * and the acoustic self-voice gate enrolls it as the agent's imprint.
 */
export const AGENT_VOICE_TIMBRE: SpeakerTimbre = {
	f0Hz: 250,
	formants: [
		[1100, 90],
		[2400, 110],
		[3800, 150],
	],
};

/** Build a `silence + synthesized speech + silence` PCM buffer. */
export function makeSpeechWithSilenceFixture(
	opts: SpeechFixtureOptions = {},
): SpeechFixture {
	const sampleRate = opts.sampleRate ?? 16_000;
	const leadSec = opts.leadSilenceSec ?? 0.5;
	const speechSec = opts.speechSec ?? 1.2;
	const tailSec = opts.tailSilenceSec ?? 0.5;
	const totalSec = leadSec + speechSec + tailSec;
	const n = Math.floor(totalSec * sampleRate);
	const pcm = new Float32Array(n);
	const speechStartSample = Math.floor(leadSec * sampleRate);
	const speechEndSample = Math.floor((leadSec + speechSec) * sampleRate);

	const rng = mulberry32(opts.seed ?? 0xe11a);
	const timbre = opts.timbre ?? DEFAULT_SPEAKER_TIMBRE;
	const bank = new FormantBank(sampleRate, timbre.formants);
	let phase = 0;
	for (let i = speechStartSample; i < speechEndSample; i++) {
		const tInSpeech = (i - speechStartSample) / sampleRate;
		// Syllable-rate vibrato proportional to the speaker's base pitch (the
		// original shared voice swung 30 Hz around 110 Hz ≈ ±27%).
		const f0 =
			timbre.f0Hz * (1 + 0.27 * Math.sin(2 * Math.PI * 5 * tInSpeech)) +
			(rng() - 0.5) * 4;
		phase += f0 / sampleRate;
		let excitation = 0;
		if (phase >= 1) {
			phase -= 1;
			excitation = 1;
		}
		// Syllable-rate amplitude envelope (~4 Hz).
		const amp = Math.max(
			0,
			0.6 * (1 + Math.sin(2 * Math.PI * 4 * tInSpeech - Math.PI / 2)),
		);
		excitation *= amp;
		pcm[i] = bank.step(excitation) * 0.15;
	}
	return { pcm, sampleRate, speechStartSample, speechEndSample };
}
