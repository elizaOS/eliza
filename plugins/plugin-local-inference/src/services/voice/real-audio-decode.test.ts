/** Covers `decodeMonoPcm16Wav` against a committed corpus of real WAV files. Real audio fixtures. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeMonoPcm16Wav, encodeMonoPcm16Wav } from "./engine-bridge";

/**
 * Real-audio coverage for the front of the single FFI pipe: the WAV → PCM
 * decoder every transcription path feeds (`decodeMonoPcm16Wav`), exercised
 * against the committed real WAV files rather than synthetic in-memory buffers.
 *
 * Two real corpora:
 *   1. `native/verify/asr_bench_fixtures/non_publish_structure_5utt/` — five
 *      committed mono 16 kHz PCM16 WAVs (deterministic tones, NOT speech — see
 *      the corpus manifest; valid for decode/codec validation, NOT for WER).
 *   2. `native/audio-fixtures/freeman.wav` — a real 22.05 kHz speech
 *      recording committed to the repo, so the block is skipped only when the
 *      fixture is absent.
 */

const FIXTURE_DIR = fileURLToPath(
	new URL(
		"../../../native/verify/asr_bench_fixtures/non_publish_structure_5utt/",
		import.meta.url,
	),
);

interface FixtureManifest {
	realRecorded: boolean;
	files: Array<{
		id: string;
		reference: string;
		wav: string;
		txt: string;
		sampleRateHz: number;
	}>;
}

const manifest = JSON.parse(
	readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
) as FixtureManifest;

/**
 * Every decoded sample must be a finite mono amplitude in [-1, 1]. Scan in a
 * plain loop and assert the AGGREGATE once — a per-sample `expect()` over a
 * multi-second clip (freeman.wav is ~380k samples) is pathologically slow and
 * trips the test timeout under load.
 */
function assertInRangePcm(pcm: Float32Array): void {
	expect(pcm.length).toBeGreaterThan(0);
	let allFinite = true;
	let maxAbs = 0;
	for (let i = 0; i < pcm.length; i++) {
		const s = pcm[i] ?? Number.NaN;
		if (!Number.isFinite(s)) {
			allFinite = false;
			break;
		}
		const abs = Math.abs(s);
		if (abs > maxAbs) maxAbs = abs;
	}
	expect(allFinite).toBe(true);
	expect(maxAbs).toBeLessThanOrEqual(1);
}

describe("decodeMonoPcm16Wav — committed fixture corpus (real WAV files)", () => {
	it("decodes every fixture to in-range mono PCM at the manifest sample rate", () => {
		expect(manifest.files.length).toBeGreaterThanOrEqual(5);
		for (const f of manifest.files) {
			const bytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, f.wav)));
			const { pcm, sampleRate } = decodeMonoPcm16Wav(bytes);

			expect(sampleRate).toBe(f.sampleRateHz);
			assertInRangePcm(pcm);

			const durationMs = (1000 * pcm.length) / sampleRate;
			expect(durationMs).toBeGreaterThan(0);
			expect(Number.isFinite(durationMs)).toBe(true);

			// Corpus integrity: the sidecar .txt matches the manifest reference
			// (these are the references a real-speech replacement corpus must hit).
			const txt = readFileSync(join(FIXTURE_DIR, f.txt), "utf8").trim();
			expect(txt).toBe(f.reference);
		}
	});

	it("round-trips decode → encode → decode losslessly (PCM16 codec)", () => {
		const first = manifest.files[0];
		expect(first).toBeDefined();
		const bytes = new Uint8Array(
			readFileSync(
				join(FIXTURE_DIR, (first as FixtureManifest["files"][0]).wav),
			),
		);
		const a = decodeMonoPcm16Wav(bytes);
		const reencoded = encodeMonoPcm16Wav(a.pcm, a.sampleRate);
		const b = decodeMonoPcm16Wav(reencoded);

		expect(b.sampleRate).toBe(a.sampleRate);
		expect(b.pcm.length).toBe(a.pcm.length);
		// PCM16 → float → PCM16 is exact (the float values are k/0x8000).
		for (let i = 0; i < a.pcm.length; i++) {
			expect(b.pcm[i]).toBeCloseTo(a.pcm[i] ?? 0, 6);
		}
	});

	it("documents that the fixture corpus is non-speech (not WER evidence)", () => {
		// Guards against anyone treating these tones as ASR ground truth.
		expect(manifest.realRecorded).toBe(false);
	});
});

const FREEMAN_WAV = fileURLToPath(
	new URL("../../../native/audio-fixtures/freeman.wav", import.meta.url),
);
const hasFreeman = existsSync(FREEMAN_WAV);
const describeFreeman = hasFreeman ? describe : describe.skip;

describeFreeman(
	"decodeMonoPcm16Wav — freeman.wav (real 22.05 kHz speech)",
	() => {
		it("decodes to several seconds of bipolar in-range speech PCM", () => {
			const bytes = new Uint8Array(readFileSync(FREEMAN_WAV));
			const { pcm, sampleRate } = decodeMonoPcm16Wav(bytes);

			expect(sampleRate).toBe(22_050);
			assertInRangePcm(pcm);

			// Real speech is bipolar, not silence or a DC tone.
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			for (let i = 0; i < pcm.length; i++) {
				const s = pcm[i] ?? 0;
				if (s < min) min = s;
				if (s > max) max = s;
			}
			expect(min).toBeLessThan(0);
			expect(max).toBeGreaterThan(0);

			const durationSec = pcm.length / sampleRate;
			expect(durationSec).toBeGreaterThan(1);
			expect(durationSec).toBeLessThan(60);
		});
	},
);
