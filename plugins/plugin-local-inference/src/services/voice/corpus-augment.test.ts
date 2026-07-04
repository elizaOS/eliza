/** Unit tests for corpus augmentation: dB helpers and additive noise (babble/music). Deterministic. */
import { describe, expect, it } from "vitest";
import {
	addNoise,
	applyGainDb,
	applyLowQualityLine,
	applyReverb,
	augmentPcm,
	dbToGain,
	estimateSnrDb,
	measureRms,
	mixInto,
	type NoiseKind,
	specIsClean,
} from "./corpus-augment";

const SR = 16_000;

/** A deterministic voiced tone with leading + trailing silence. */
function makeTone(freq: number, durSec: number, gap = 0.2) {
	const gapN = Math.round(gap * SR);
	const n = Math.round(durSec * SR) + gapN * 2;
	const pcm = new Float32Array(n);
	for (let i = gapN; i < n - gapN; i++) {
		pcm[i] = 0.5 * Math.sin((2 * Math.PI * freq * (i - gapN)) / SR);
	}
	return { pcm, voicedStart: gapN, voicedEnd: n - gapN };
}

describe("corpus-augment dB helpers", () => {
	it("dbToGain: +6 dB ≈ ×2, −6 dB ≈ ×0.5", () => {
		expect(dbToGain(6)).toBeCloseTo(2, 1);
		expect(dbToGain(-6)).toBeCloseTo(0.5, 1);
		expect(dbToGain(0)).toBe(1);
	});

	it("estimateSnrDb recovers a known ratio", () => {
		expect(estimateSnrDb(1, 0.1)).toBeCloseTo(20, 5);
		expect(estimateSnrDb(1, 0)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("addNoise", () => {
	it("hits the target SNR within ~1.5 dB", () => {
		const { pcm } = makeTone(220, 1.0, 0);
		const noisy = addNoise(pcm, { snrDb: 10, seed: 1 });
		// Recover the noise as (noisy − clean) and compare RMS.
		const noise = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) noise[i] = noisy[i] - pcm[i];
		const snr = estimateSnrDb(measureRms(pcm), measureRms(noise));
		expect(snr).toBeGreaterThan(8.5);
		expect(snr).toBeLessThan(11.5);
	});

	it("lower SNR is louder noise", () => {
		const { pcm } = makeTone(220, 0.5, 0);
		const n5 = addNoise(pcm, { snrDb: 5, seed: 2 });
		const n20 = addNoise(pcm, { snrDb: 20, seed: 2 });
		const noise5 = measureRms(n5) - measureRms(pcm);
		const noise20 = measureRms(n20) - measureRms(pcm);
		// 5 dB SNR adds more energy than 20 dB SNR.
		expect(measureRms(n5)).toBeGreaterThan(measureRms(n20));
		expect(noise5).toBeGreaterThan(noise20);
	});

	it("is deterministic for a given seed", () => {
		const { pcm } = makeTone(300, 0.3, 0.1);
		const a = addNoise(pcm, { snrDb: 8, seed: 42 });
		const b = addNoise(pcm, { snrDb: 8, seed: 42 });
		const c = addNoise(pcm, { snrDb: 8, seed: 43 });
		expect(Array.from(a)).toEqual(Array.from(b));
		expect(Array.from(a)).not.toEqual(Array.from(c));
	});

	it("raises the floor in formerly-silent regions", () => {
		const { pcm, voicedEnd } = makeTone(220, 0.5, 0.2);
		const tailBefore = measureRms(pcm, voicedEnd);
		const noisy = addNoise(pcm, { snrDb: 10, seed: 7 });
		const tailAfter = measureRms(noisy, voicedEnd);
		expect(tailBefore).toBeLessThan(1e-4);
		expect(tailAfter).toBeGreaterThan(tailBefore);
	});
});

/** Lag-1 normalized autocorrelation: ≈1 for a smooth/tonal signal, ≈0 for
 * uncorrelated white noise. */
function lag1Autocorr(x: Float32Array): number {
	let num = 0;
	let den = 0;
	for (let i = 1; i < x.length; i++) num += x[i] * x[i - 1];
	for (let i = 0; i < x.length; i++) den += x[i] * x[i];
	return den > 0 ? num / den : 0;
}

describe("addNoise: music kind", () => {
	const recoverNoise = (pcm: Float32Array, kind: NoiseKind, seed: number) => {
		const noisy = addNoise(pcm, { snrDb: 6, kind, seed });
		const noise = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) noise[i] = noisy[i] - pcm[i];
		return noise;
	};

	it("hits the target SNR like the other kinds", () => {
		const { pcm } = makeTone(220, 1.0, 0);
		const noise = recoverNoise(pcm, "music", 1);
		// recoverNoise uses snrDb: 6
		const snr = estimateSnrDb(measureRms(pcm), measureRms(noise));
		expect(snr).toBeGreaterThan(4.5);
		expect(snr).toBeLessThan(7.5);
	});

	it("is tonal (smooth, highly autocorrelated) unlike flat white noise", () => {
		const { pcm } = makeTone(220, 0.5, 0);
		const music = lag1Autocorr(recoverNoise(pcm, "music", 5));
		const white = lag1Autocorr(recoverNoise(pcm, "white", 5));
		expect(music).toBeGreaterThan(0.9);
		expect(white).toBeLessThan(0.5);
		expect(music).toBeGreaterThan(white);
	});

	it("is deterministic for a seed and differs from white/pink", () => {
		const { pcm } = makeTone(300, 0.3, 0.1);
		const a = addNoise(pcm, { snrDb: 8, kind: "music", seed: 42 });
		const b = addNoise(pcm, { snrDb: 8, kind: "music", seed: 42 });
		const white = addNoise(pcm, { snrDb: 8, kind: "white", seed: 42 });
		const pink = addNoise(pcm, { snrDb: 8, kind: "pink", seed: 42 });
		expect(Array.from(a)).toEqual(Array.from(b));
		expect(Array.from(a)).not.toEqual(Array.from(white));
		expect(Array.from(a)).not.toEqual(Array.from(pink));
	});
});

describe("applyReverb", () => {
	it("spreads energy into the tail after the dry signal ends", () => {
		const { pcm, voicedEnd } = makeTone(220, 0.4, 0.0);
		const dryTail = measureRms(pcm, voicedEnd, pcm.length);
		const wet = applyReverb(pcm, SR, { room: 0.7, wet: 0.6, tailSec: 0.6 });
		// The reverb output is longer (tail appended) and the post-voice region rings.
		expect(wet.length).toBeGreaterThan(pcm.length);
		const wetTail = measureRms(
			wet,
			voicedEnd,
			voicedEnd + Math.round(0.3 * SR),
		);
		expect(wetTail).toBeGreaterThan(dryTail);
		expect(wetTail).toBeGreaterThan(1e-3);
	});

	it("is deterministic", () => {
		const { pcm } = makeTone(200, 0.2);
		const a = applyReverb(pcm, SR, { room: 0.5, wet: 0.4 });
		const b = applyReverb(pcm, SR, { room: 0.5, wet: 0.4 });
		expect(Array.from(a)).toEqual(Array.from(b));
	});
});

describe("applyGainDb (far-field attenuation)", () => {
	it("−12 dB quarters the amplitude", () => {
		const { pcm } = makeTone(220, 0.3, 0);
		const quiet = applyGainDb(pcm, -12);
		expect(measureRms(quiet) / measureRms(pcm)).toBeCloseTo(dbToGain(-12), 2);
	});
});

describe("applyLowQualityLine", () => {
	it("attenuates high-frequency content more than the speech band", () => {
		const band = makeTone(1000, 0.5, 0);
		const high = makeTone(6500, 0.5, 0);
		const bandOut = applyLowQualityLine(band.pcm, SR);
		const highOut = applyLowQualityLine(high.pcm, SR);
		const bandKept = measureRms(bandOut) / measureRms(band.pcm);
		const highKept = measureRms(highOut) / measureRms(high.pcm);
		// 6.5 kHz is above the ~3.4 kHz line cutoff → far more attenuated.
		expect(highKept).toBeLessThan(bandKept);
		expect(highKept).toBeLessThan(0.5);
	});

	it("also strips sub-300 Hz rumble", () => {
		const low = makeTone(80, 0.5, 0);
		const out = applyLowQualityLine(low.pcm, SR);
		expect(measureRms(out) / measureRms(low.pcm)).toBeLessThan(0.6);
	});
});

describe("mixInto", () => {
	it("adds an overlay at the requested level without changing length", () => {
		const base = new Float32Array(1000);
		const overlay = new Float32Array(1000).fill(0.5);
		const mixed = mixInto(base, overlay, { gainDb: -6 });
		expect(mixed.length).toBe(base.length);
		expect(mixed[500]).toBeCloseTo(0.5 * dbToGain(-6), 4);
	});

	it("honors offset and loops a short overlay", () => {
		const base = new Float32Array(100);
		const overlay = new Float32Array([1, 0]);
		const mixed = mixInto(base, overlay, { offsetSamples: 10, loop: true });
		expect(mixed[9]).toBe(0);
		expect(mixed[10]).toBe(1);
		expect(mixed[11]).toBe(0);
		expect(mixed[12]).toBe(1);
	});

	it("does not mutate the inputs", () => {
		const base = new Float32Array([0.125, 0.25]);
		const overlay = new Float32Array([0.5, 0.5]);
		mixInto(base, overlay, {});
		expect(Array.from(base)).toEqual([0.125, 0.25]);
		expect(Array.from(overlay)).toEqual([0.5, 0.5]);
	});
});

describe("augmentPcm chain", () => {
	it("specIsClean detects a no-op spec", () => {
		expect(specIsClean(undefined)).toBe(true);
		expect(specIsClean({})).toBe(true);
		expect(specIsClean({ noiseKind: "pink" })).toBe(true); // kind alone is a no-op
		expect(specIsClean({ noiseSnrDb: 10 })).toBe(false);
		expect(specIsClean({ reverb: 0.5 })).toBe(false);
		expect(specIsClean({ lowQuality: true })).toBe(false);
	});

	it("preserves length and stays within [-1, 1]", () => {
		const { pcm } = makeTone(220, 0.6, 0.15);
		const out = augmentPcm(
			pcm,
			SR,
			{ noiseSnrDb: 6, reverb: 0.7, farFieldDb: 9, lowQuality: true, seed: 3 },
			{},
		);
		expect(out.length).toBe(pcm.length);
		let peak = 0;
		for (const s of out) peak = Math.max(peak, Math.abs(s));
		expect(peak).toBeLessThanOrEqual(1);
		expect(out).not.toBe(pcm); // returns a fresh array
	});

	it("a far-field+reverb+noise voice is materially degraded vs the clean source", () => {
		const { pcm, voicedStart, voicedEnd } = makeTone(220, 0.8, 0.2);
		const out = augmentPcm(
			pcm,
			SR,
			{ farFieldDb: 12, reverb: 0.8, noiseSnrDb: 8, seed: 9 },
			{},
		);
		// The voiced region is quieter (far-field) yet the silent tail now has a
		// noise floor — i.e. SNR dropped, which is the whole point.
		const cleanVoiced = measureRms(pcm, voicedStart, voicedEnd);
		const outVoiced = measureRms(out, voicedStart, voicedEnd);
		expect(outVoiced).toBeLessThan(cleanVoiced);
		expect(measureRms(out, voicedEnd)).toBeGreaterThan(
			measureRms(pcm, voicedEnd),
		);
	});

	it("mixes background talkers when babble is supplied", () => {
		const { pcm } = makeTone(220, 0.5, 0.1);
		const babble = makeTone(440, 0.5, 0).pcm;
		const withBabble = augmentPcm(
			pcm,
			SR,
			{ backgroundTalkersDb: 6 },
			{ babble },
		);
		const without = augmentPcm(pcm, SR, { backgroundTalkersDb: 6 }, {});
		// Babble present → louder than the no-babble control (which is a no-op).
		expect(measureRms(withBabble)).toBeGreaterThan(measureRms(without));
	});

	it("is fully deterministic end-to-end", () => {
		const { pcm } = makeTone(220, 0.4, 0.1);
		const spec = { noiseSnrDb: 7, reverb: 0.5, lowQuality: true, seed: 11 };
		const a = augmentPcm(pcm, SR, spec, {});
		const b = augmentPcm(pcm, SR, spec, {});
		expect(Array.from(a)).toEqual(Array.from(b));
	});
});
