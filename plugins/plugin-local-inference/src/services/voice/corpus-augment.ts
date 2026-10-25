/**
 * Voice Workbench corpus augmentation — acoustic degradation DSP (#8785).
 *
 * Real rooms are not clean. The corpus generator produces dry speech; this
 * module degrades it the way a microphone actually hears it: additive room
 * noise at a target SNR, reverberation (near vs far), far-field attenuation,
 * a low-quality/telephone line, compression/clip/dropout artifacts, and
 * competing background talkers. Every function is PURE and DETERMINISTIC
 * (seeded PRNG, no `Math.random`, no I/O), so the same scenario + seed always
 * yields byte-identical audio — a labeled, reproducible corpus the real
 * ASR/diarization/EOT models can be benchmarked against, and the DSP itself is
 * unit-testable in CI with no models.
 *
 * Layering: this module knows nothing about scenarios. It operates on mono
 * `Float32Array` PCM at a given sample rate. `corpus-generator.ts` translates a
 * scenario's declarative {@link AugmentationSpec} into these calls.
 */

/** Deterministic PRNG (mulberry32) — no `Math.random`, reproducible corpora. */
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

/** Box–Muller standard-normal sample from a uniform PRNG. */
function gaussian(rng: () => number): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = rng();
	while (v === 0) v = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Root-mean-square amplitude over [start, end). */
export function measureRms(
	pcm: Float32Array,
	start = 0,
	end = pcm.length,
): number {
	const lo = Math.max(0, start);
	const hi = Math.min(pcm.length, end);
	if (hi <= lo) return 0;
	let sum = 0;
	for (let i = lo; i < hi; i++) sum += pcm[i] * pcm[i];
	return Math.sqrt(sum / (hi - lo));
}

/** Peak absolute amplitude over [start, end). */
export function measurePeak(
	pcm: Float32Array,
	start = 0,
	end = pcm.length,
): number {
	const lo = Math.max(0, start);
	const hi = Math.min(pcm.length, end);
	let peak = 0;
	for (let i = lo; i < hi; i++) {
		const a = Math.abs(pcm[i]);
		if (a > peak) peak = a;
	}
	return peak;
}

/** Linear amplitude ratio for a dB gain (+6 dB ≈ ×2, −6 dB ≈ ×0.5). */
export function dbToGain(db: number): number {
	return 10 ** (db / 20);
}

/** Estimated SNR (dB) of a signal region against a noise-only region. */
export function estimateSnrDb(signalRms: number, noiseRms: number): number {
	if (noiseRms <= 0) return Number.POSITIVE_INFINITY;
	if (signalRms <= 0) return Number.NEGATIVE_INFINITY;
	return 20 * Math.log10(signalRms / noiseRms);
}

export type NoiseKind = "white" | "pink" | "music";

/**
 * Add background noise at a target SNR (dB) relative to the signal's voiced RMS.
 * Lower `snrDb` = noisier. `pink` is a one-pole-filtered approximation of 1/f
 * room rumble; `white` is flat; `music` is a seeded harmonic chord (a few
 * detuned partials under a slow tremolo) — tonal and sustained, the kind of
 * steady background that fools an energy-only VAD where flat hiss would not.
 * The noise floor is added across the WHOLE stream (including silent gaps) so
 * silence is no longer pristine — exactly the condition that makes a real
 * VAD/EOT classifier work for its living.
 */
export function addNoise(
	pcm: Float32Array,
	opts: { snrDb: number; kind?: NoiseKind; seed?: number },
): Float32Array {
	const rng = mulberry32(opts.seed ?? 0x5eed);
	const signalRms = measureRms(pcm) || 1e-6;
	const targetNoiseRms = signalRms / dbToGain(opts.snrDb);

	const raw = new Float32Array(pcm.length);
	const kind = opts.kind ?? "white";
	if (kind === "pink") {
		// One-pole low-pass of white noise ≈ pink-ish (−~6 dB/oct) room rumble.
		let prev = 0;
		const alpha = 0.92;
		for (let i = 0; i < raw.length; i++) {
			const w = gaussian(rng);
			prev = alpha * prev + (1 - alpha) * w;
			raw[i] = prev;
		}
	} else if (kind === "music") {
		// A seeded harmonic chord: detuned partials (root, major third, fifth,
		// octave) under a slow tremolo. Normalized frequencies (cycles/sample)
		// keep it sample-rate-agnostic; the RMS scaling below still pins it to the
		// requested SNR. Tonal + sustained, unlike flat white / pink rumble.
		const fundamental = 0.018; // ≈ 288 Hz @ 16 kHz, ≈ 864 Hz @ 48 kHz
		const partials = [
			{ ratio: 1, amp: 1.0 },
			{ ratio: 1.26, amp: 0.5 }, // ~major third (5:4)
			{ ratio: 1.5, amp: 0.6 }, // perfect fifth (3:2)
			{ ratio: 2, amp: 0.4 }, // octave
		];
		const tuned = partials.map((p) => ({
			freq: fundamental * p.ratio * (1 + (rng() - 0.5) * 0.01), // ±0.5% detune
			amp: p.amp,
			phase: rng() * 2 * Math.PI,
		}));
		const tremRate = 0.0006; // slow amplitude modulation
		const tremPhase = rng() * 2 * Math.PI;
		for (let i = 0; i < raw.length; i++) {
			let s = 0;
			for (const t of tuned) {
				s += t.amp * Math.sin(2 * Math.PI * t.freq * i + t.phase);
			}
			const trem = 0.7 + 0.3 * Math.sin(2 * Math.PI * tremRate * i + tremPhase);
			raw[i] = s * trem;
		}
	} else {
		for (let i = 0; i < raw.length; i++) raw[i] = gaussian(rng);
	}

	const rawRms = measureRms(raw) || 1e-6;
	const scale = targetNoiseRms / rawRms;
	const out = new Float32Array(pcm.length);
	for (let i = 0; i < out.length; i++) out[i] = pcm[i] + raw[i] * scale;
	return out;
}

/** RBJ biquad coefficients (transposed direct form II applied below). */
interface Biquad {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

function lowpassBiquad(
	sampleRate: number,
	freq: number,
	q = Math.SQRT1_2,
): Biquad {
	const w0 = (2 * Math.PI * freq) / sampleRate;
	const cos = Math.cos(w0);
	const alpha = Math.sin(w0) / (2 * q);
	const a0 = 1 + alpha;
	return {
		b0: (1 - cos) / 2 / a0,
		b1: (1 - cos) / a0,
		b2: (1 - cos) / 2 / a0,
		a1: (-2 * cos) / a0,
		a2: (1 - alpha) / a0,
	};
}

function highpassBiquad(
	sampleRate: number,
	freq: number,
	q = Math.SQRT1_2,
): Biquad {
	const w0 = (2 * Math.PI * freq) / sampleRate;
	const cos = Math.cos(w0);
	const alpha = Math.sin(w0) / (2 * q);
	const a0 = 1 + alpha;
	return {
		b0: (1 + cos) / 2 / a0,
		b1: -(1 + cos) / a0,
		b2: (1 + cos) / 2 / a0,
		a1: (-2 * cos) / a0,
		a2: (1 - alpha) / a0,
	};
}

function applyBiquad(pcm: Float32Array, c: Biquad): Float32Array {
	const out = new Float32Array(pcm.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	for (let i = 0; i < pcm.length; i++) {
		const x0 = pcm[i];
		const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
		out[i] = y0;
	}
	return out;
}

/** µ-law companding round-trip with 8-bit quantization (codec degradation). */
function muLawRoundTrip(pcm: Float32Array): Float32Array {
	const mu = 255;
	const out = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) {
		const x = Math.max(-1, Math.min(1, pcm[i]));
		const sign = x < 0 ? -1 : 1;
		// Encode to companded domain, quantize to 8 bits, decode back.
		const y = (sign * Math.log1p(mu * Math.abs(x))) / Math.log1p(mu);
		const q = Math.round(((y + 1) / 2) * 255) / 255; // 0..1, 8-bit
		const yd = q * 2 - 1;
		const sd = yd < 0 ? -1 : 1;
		out[i] = (sd * ((1 + mu) ** Math.abs(yd) - 1)) / mu;
	}
	return out;
}

/**
 * Simulate a low-quality / telephone line: band-limit to ~300–3400 Hz then
 * companded 8-bit quantization. Cheap mics and phone codecs strip the highs and
 * add quantization grunge, which is the dominant real-world ASR stressor for
 * "voices near and far" / low-quality input.
 */
export function applyLowQualityLine(
	pcm: Float32Array,
	sampleRate: number,
): Float32Array {
	const hp = highpassBiquad(sampleRate, 300);
	const lpFreq = Math.min(3400, sampleRate / 2 - 100);
	const lp = lowpassBiquad(sampleRate, lpFreq);
	return muLawRoundTrip(applyBiquad(applyBiquad(pcm, hp), lp));
}

/**
 * Freeverb-style Schroeder reverb (4 parallel combs → 2 series allpasses),
 * mixed with the dry signal. `room` (0..1) sets reflection density/decay;
 * `wet` (0..1) the reflected level. Reverb spreads energy in time — speech
 * keeps ringing after the talker stops — which is what makes a far/reverberant
 * voice hard to endpoint and to diarize. The output is `dry.length + tail`
 * samples so the decay is preserved (callers may keep or trim the tail).
 */
export function applyReverb(
	pcm: Float32Array,
	sampleRate: number,
	opts: { room?: number; wet?: number; tailSec?: number } = {},
): Float32Array {
	const room = Math.max(0, Math.min(1, opts.room ?? 0.6));
	const wet = Math.max(0, Math.min(1, opts.wet ?? 0.4));
	const tailSamples = Math.round((opts.tailSec ?? 0.6) * sampleRate);
	const n = pcm.length + tailSamples;

	// Classic Freeverb tunings (samples @ 44.1 kHz), scaled to this sample rate.
	const sr = sampleRate / 44100;
	const combTunings = [1116, 1188, 1277, 1356].map((d) =>
		Math.max(1, Math.round(d * sr)),
	);
	const allpassTunings = [556, 441].map((d) => Math.max(1, Math.round(d * sr)));
	const feedback = room * 0.28 + 0.7;
	const damp = 0.2;

	const combBufs = combTunings.map((d) => new Float32Array(d));
	const combIdx = combTunings.map(() => 0);
	const combFilter = combTunings.map(() => 0);
	const apBufs = allpassTunings.map((d) => new Float32Array(d));
	const apIdx = allpassTunings.map(() => 0);

	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const dry = i < pcm.length ? pcm[i] : 0;
		let combSum = 0;
		for (let c = 0; c < combBufs.length; c++) {
			const buf = combBufs[c];
			const idx = combIdx[c];
			const sample = buf[idx];
			combFilter[c] = sample * (1 - damp) + combFilter[c] * damp;
			buf[idx] = dry + combFilter[c] * feedback;
			combIdx[c] = (idx + 1) % buf.length;
			combSum += sample;
		}
		let wetSig = combSum / combBufs.length;
		for (let a = 0; a < apBufs.length; a++) {
			const buf = apBufs[a];
			const idx = apIdx[a];
			const bufOut = buf[idx];
			const input = wetSig;
			buf[idx] = input + bufOut * 0.5;
			apIdx[a] = (idx + 1) % buf.length;
			wetSig = bufOut - input;
		}
		out[i] = dry * (1 - wet) + wetSig * wet;
	}
	return out;
}

/** Multiply the whole stream by a dB gain (far-field attenuation = negative). */
export function applyGainDb(pcm: Float32Array, db: number): Float32Array {
	const g = dbToGain(db);
	const out = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g;
	return out;
}

/**
 * Mix an overlay stream (a competing talker, babble, or the agent's own TTS for
 * an echo test) into a base stream at a given level, starting at `offsetSamples`
 * and optionally looping the overlay to cover the base. The base length is
 * preserved. Returns a new array; neither input is mutated.
 */
export function mixInto(
	base: Float32Array,
	overlay: Float32Array,
	opts: { gainDb?: number; offsetSamples?: number; loop?: boolean } = {},
): Float32Array {
	const out = Float32Array.from(base);
	if (overlay.length === 0) return out;
	const g = dbToGain(opts.gainDb ?? 0);
	const offset = Math.max(0, Math.round(opts.offsetSamples ?? 0));
	const loop = opts.loop ?? false;
	for (let i = offset; i < out.length; i++) {
		const j = i - offset;
		const src = loop ? overlay[j % overlay.length] : overlay[j];
		if (src === undefined) break;
		out[i] += src * g;
	}
	return out;
}

export function applyClipping(
	pcm: Float32Array,
	threshold: number,
): Float32Array {
	const clip = Math.max(0.01, Math.min(1, Math.abs(threshold)));
	const out = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) {
		out[i] = Math.max(-clip, Math.min(clip, pcm[i]));
	}
	return out;
}

export function applyCompressionArtifacts(
	pcm: Float32Array,
	amount: number,
): Float32Array {
	const severity = Math.max(0, Math.min(1, amount));
	if (severity === 0) return Float32Array.from(pcm);
	const bits = Math.max(4, Math.round(16 - severity * 10));
	const levels = 2 ** (bits - 1) - 1;
	const hold = Math.max(1, Math.round(severity * 4));
	const out = new Float32Array(pcm.length);
	let held = 0;
	for (let i = 0; i < pcm.length; i++) {
		if (i % hold === 0) {
			const clipped = Math.max(-1, Math.min(1, pcm[i]));
			held = Math.round(clipped * levels) / levels;
		}
		out[i] = held;
	}
	return out;
}

export function applyPacketDropouts(
	pcm: Float32Array,
	sampleRate: number,
	opts: { probability: number; dropoutMs?: number; seed?: number },
): Float32Array {
	const probability = Math.max(0, Math.min(1, opts.probability));
	const windowSamples = Math.max(
		1,
		Math.round(((opts.dropoutMs ?? 35) / 1000) * sampleRate),
	);
	const rng = mulberry32(opts.seed ?? 0xd00d);
	const out = Float32Array.from(pcm);
	for (let start = 0; start < out.length; start += windowSamples) {
		if (rng() > probability) continue;
		const end = Math.min(out.length, start + windowSamples);
		for (let i = start; i < end; i++) out[i] = 0;
	}
	return out;
}

/** Declarative degradation for one stream (the scenario's `environment`). */
export interface AugmentationSpec {
	/** Additive room-noise SNR (dB) relative to voiced speech. Lower = noisier. */
	noiseSnrDb?: number;
	/** Noise character (default white). */
	noiseKind?: NoiseKind;
	/** Reverb room size 0..1 (near→far, small→large room). */
	reverb?: number;
	/** Reverb wet level 0..1 (defaults from `reverb` when omitted). */
	reverbWet?: number;
	/** Far-field attenuation in dB (how many dB QUIETER; positive number). */
	farFieldDb?: number;
	/** Band-limit + 8-bit companding (telephone / cheap-mic line). */
	lowQuality?: boolean;
	/** Hard clip to +/- this absolute amplitude. */
	clipThreshold?: number;
	/** Quantization/sample-hold compression artifact severity, 0..1. */
	compressionArtifacts?: number;
	/** Probability that each packet-sized window is zeroed, 0..1. */
	dropoutProbability?: number;
	/** Dropout window size in ms (default 35). */
	dropoutMs?: number;
	/** Competing background talkers, mixed this many dB BELOW the speech. */
	backgroundTalkersDb?: number;
	/** Deterministic seed for noise/babble. */
	seed?: number;
}

/** True when the spec asks for any degradation at all. */
export function specIsClean(spec: AugmentationSpec | undefined): boolean {
	if (!spec) return true;
	return (
		spec.noiseSnrDb === undefined &&
		spec.reverb === undefined &&
		spec.farFieldDb === undefined &&
		!spec.lowQuality &&
		spec.clipThreshold === undefined &&
		spec.compressionArtifacts === undefined &&
		spec.dropoutProbability === undefined &&
		spec.backgroundTalkersDb === undefined
	);
}

export interface AugmentPcmOptions {
	/**
	 * A babble source (a competing-talker stream) for `backgroundTalkersDb`.
	 * The generator supplies one synthesized from other voices; omitted = no
	 * background talkers even if the spec asks (the runner logs the gap).
	 */
	babble?: Float32Array;
	/** Trim reverb tail back to the input length (keeps corpus timing exact). */
	trimReverbTail?: boolean;
}

/**
 * Apply a full degradation chain to one stream, in acoustically sensible order:
 * background talkers → reverb (room reflections) → far-field gain → low-quality
 * line → additive noise floor. Pure; returns a new array.
 */
export function augmentPcm(
	pcm: Float32Array,
	sampleRate: number,
	spec: AugmentationSpec,
	options: AugmentPcmOptions = {},
): Float32Array {
	let out = pcm;

	if (
		spec.backgroundTalkersDb !== undefined &&
		options.babble &&
		options.babble.length > 0
	) {
		out = mixInto(out, options.babble, {
			gainDb: -Math.abs(spec.backgroundTalkersDb),
			loop: true,
		});
	}

	if (spec.reverb !== undefined && spec.reverb > 0) {
		const reverbed = applyReverb(out, sampleRate, {
			room: spec.reverb,
			...(spec.reverbWet !== undefined ? { wet: spec.reverbWet } : {}),
		});
		out =
			options.trimReverbTail !== false
				? reverbed.subarray(0, pcm.length)
				: reverbed;
	}

	if (spec.farFieldDb !== undefined && spec.farFieldDb !== 0) {
		out = applyGainDb(out, -Math.abs(spec.farFieldDb));
	}

	if (spec.lowQuality) {
		out = applyLowQualityLine(out, sampleRate);
	}

	if (
		spec.compressionArtifacts !== undefined &&
		spec.compressionArtifacts > 0
	) {
		out = applyCompressionArtifacts(out, spec.compressionArtifacts);
	}

	if (spec.dropoutProbability !== undefined && spec.dropoutProbability > 0) {
		out = applyPacketDropouts(out, sampleRate, {
			probability: spec.dropoutProbability,
			...(spec.dropoutMs !== undefined ? { dropoutMs: spec.dropoutMs } : {}),
			...(spec.seed !== undefined ? { seed: spec.seed } : {}),
		});
	}

	if (spec.noiseSnrDb !== undefined) {
		out = addNoise(out, {
			snrDb: spec.noiseSnrDb,
			...(spec.noiseKind ? { kind: spec.noiseKind } : {}),
			...(spec.seed !== undefined ? { seed: spec.seed } : {}),
		});
	}

	if (spec.clipThreshold !== undefined) {
		out = applyClipping(out, spec.clipThreshold);
	}

	// Defensive de-clip: degradation chains can briefly exceed [-1, 1].
	let peak = 0;
	for (let i = 0; i < out.length; i++) {
		const a = Math.abs(out[i]);
		if (a > peak) peak = a;
	}
	if (peak > 1) {
		const norm = 0.999 / peak;
		const scaled = new Float32Array(out.length);
		for (let i = 0; i < out.length; i++) scaled[i] = out[i] * norm;
		out = scaled;
	}

	// Always return a fresh array of exactly the input length.
	return out.length === pcm.length && out !== pcm
		? out
		: Float32Array.from(out);
}
