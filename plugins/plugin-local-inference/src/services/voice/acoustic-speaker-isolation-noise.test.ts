/** Speaker isolation under babble, overlap, and transient bystanders (#10726), driven by synthetic mixed speech. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	makeSpeechWithSilenceFixture,
	type SpeakerTimbre,
	speakerTimbreForIndex,
} from "./__test-helpers__/synthetic-speech";
import {
	extractTimbreEmbedding,
	OnlineSpeakerClusterer,
} from "./acoustic-speaker-attribution";
import { addNoise, mixInto } from "./corpus-augment";
import { cosineSimilarity } from "./speaker-imprint";

/**
 * Speaker isolation under REAL acoustic adversity (#10726 pillar 5 — noise
 * rejection + speaker isolation, "SNR-vs-accuracy curves"). The clean-condition
 * separation lives in `acoustic-speaker-attribution.test.ts`; these tests pin
 * the *degradation curve* the user cares about: does the acoustic attributor
 * still recover the target speaker when there is a conversation happening in the
 * room (babble), when two people talk over each other (overlap), and when a
 * bystander walks in, speaks, and leaves (a transient A/B/A turn)?
 *
 * Every threshold below is grounded in the measured behavior of the shipped
 * `extractTimbreEmbedding` / `OnlineSpeakerClusterer` on deterministic synthetic
 * speech (no model, no network) — set with margin, not guessed.
 */

const SR = 16_000;
function clip(
	timbre: SpeakerTimbre,
	seed: number,
	speechSec = 1,
): Float32Array {
	return makeSpeechWithSilenceFixture({
		sampleRate: SR,
		leadSilenceSec: 0.05,
		speechSec,
		tailSilenceSec: 0.05,
		seed,
		timbre,
	}).pcm;
}

const A = speakerTimbreForIndex(0, 2);
const B = speakerTimbreForIndex(1, 2);

describe("speaker isolation under room babble (#10726)", () => {
	const aClean = clip(A, 1);
	const embAClean = extractTimbreEmbedding(aClean, SR);
	const embBClean = extractTimbreEmbedding(clip(B, 2), SR);
	// Measured (music-noise babble on A): simToA 1.00 → 0.90 as SNR 30 → 0 dB;
	// simToB never rises above ~0.13. So A stays clearly A even at 0 dB SNR.
	const simA = (snrDb: number) =>
		cosineSimilarity(
			extractTimbreEmbedding(
				addNoise(aClean, { snrDb, kind: "music", seed: 7 }),
				SR,
			),
			embAClean,
		);
	const simB = (snrDb: number) =>
		cosineSimilarity(
			extractTimbreEmbedding(
				addNoise(aClean, { snrDb, kind: "music", seed: 7 }),
				SR,
			),
			embBClean,
		);

	it("keeps the target speaker identifiable down to 0 dB SNR", () => {
		// Even when the room babble is as loud as the speech (0 dB), the noisy
		// clip is still far closer to the target than to the other speaker.
		expect(simA(0)).toBeGreaterThan(0.85);
		expect(simB(0)).toBeLessThan(0.3);
		expect(simA(0) - simB(0)).toBeGreaterThan(0.5);
		// A moderately noisy room (6 dB) barely perturbs identity.
		expect(simA(6)).toBeGreaterThan(0.95);
		// Light babble (15 dB) is essentially transparent.
		expect(simA(15)).toBeGreaterThan(0.99);
	});

	it("degrades gracefully (monotonic), never a cliff or a random flip", () => {
		const curve = [30, 15, 6, 3, 0].map(simA);
		for (let i = 1; i < curve.length; i++) {
			// Louder noise never IMPROVES the match (small epsilon for FP noise).
			expect(curve[i]).toBeLessThanOrEqual(curve[i - 1] + 1e-3);
		}
		// And the whole curve stays above the cross-speaker confusion band.
		for (const snr of [30, 15, 6, 3, 0]) {
			expect(simA(snr)).toBeGreaterThan(simB(snr) + 0.5);
		}
	});
});

describe("two people talking over each other (#10726)", () => {
	const aClean = clip(A, 1);
	const embAClean = extractTimbreEmbedding(aClean, SR);
	const embBClean = extractTimbreEmbedding(clip(B, 2), SR);
	const interferer = clip(B, 5);
	const sim = (gainDb: number) => {
		const emb = extractTimbreEmbedding(
			mixInto(aClean, interferer, { gainDb }),
			SR,
		);
		return {
			a: cosineSimilarity(emb, embAClean),
			b: cosineSimilarity(emb, embBClean),
		};
	};

	it("attributes the mix to the DOMINANT speaker while the target leads", () => {
		// Interferer 12 dB down: the target clearly owns the mix.
		const quiet = sim(-12);
		expect(quiet.a).toBeGreaterThan(0.9);
		expect(quiet.a).toBeGreaterThan(quiet.b);
		// Even at 6 dB down the target still wins.
		const near = sim(-6);
		expect(near.a).toBeGreaterThan(near.b);
	});

	it("flips to the interferer at parity — the metric is not rigged to pick A", () => {
		// When the second voice is as loud as the target, the mix leans to the
		// interferer. A tautological/rigged separator could never show this.
		const equal = sim(0);
		expect(equal.b).toBeGreaterThan(equal.a);
	});

	it("separation degrades monotonically as the interferer gets louder", () => {
		const gains = [-24, -18, -12, -6, 0];
		const a = gains.map((g) => sim(g).a);
		const b = gains.map((g) => sim(g).b);
		for (let i = 1; i < gains.length; i++) {
			expect(a[i]).toBeLessThan(a[i - 1]); // target similarity falls
			expect(b[i]).toBeGreaterThan(b[i - 1]); // interferer similarity rises
		}
	});
});

describe("a bystander walks in, speaks, and leaves (#10726)", () => {
	it("tracks an A/B/A conversation under room babble (transient speaker)", () => {
		// The passer-by (B) appears for one turn between the user's (A) turns;
		// the blind clusterer must not fold B into A, and must recognize A again
		// when they resume — even with a conversation audible in the room.
		for (const snrDb of [30, 15, 8]) {
			const c = new OnlineSpeakerClusterer();
			const babble = (pcm: Float32Array) =>
				addNoise(pcm, { snrDb, kind: "music", seed: 11 });
			const seq = [
				c.assignAudio(babble(clip(A, 1)), SR),
				c.assignAudio(babble(clip(B, 2)), SR),
				c.assignAudio(babble(clip(A, 3)), SR),
			];
			expect(seq).toEqual(["spk0", "spk1", "spk0"]);
		}
	});
});
