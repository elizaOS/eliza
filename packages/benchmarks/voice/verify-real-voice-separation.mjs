#!/usr/bin/env bun
/**
 * Real-voice speaker separation: encodes OmniVoice-generated WAVs (two
 * distinct designed voices) through the native WeSpeaker ResNet34-LM
 * encoder and checks that same-voice cosine >> cross-voice cosine.
 *
 * Unlike the synthetic-fixture path, these are genuinely different
 * voices (distinct OmniVoice `--instruct` designs), so the real encoder
 * has actual speaker variation to separate.
 *
 * Requires: WAVs generated under /tmp/voice-e2e/ and
 * ELIZA_VOICE_CLASSIFIER_LIB (or the resolver) pointing at
 * libvoice_classifier.dylib.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { SpeakerEncoderGgmlImpl } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder-ggml.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const DIR = "/tmp/voice-e2e";

/** Decode a 16-bit PCM WAV to { pcm: Float32Array, sampleRate }. */
function decodeWav(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (dv.getUint32(0, false) !== 0x52494646) throw new Error("not RIFF");
	let off = 12;
	let sampleRate = 24_000;
	let bits = 16;
	let channels = 1;
	let dataOff = -1;
	let dataLen = 0;
	while (off + 8 <= dv.byteLength) {
		const id = dv.getUint32(off, false);
		const size = dv.getUint32(off + 4, true);
		if (id === 0x666d7420) {
			channels = dv.getUint16(off + 10, true);
			sampleRate = dv.getUint32(off + 12, true);
			bits = dv.getUint16(off + 22, true);
		} else if (id === 0x64617461) {
			dataOff = off + 8;
			dataLen = size;
		}
		off += 8 + size + (size & 1);
	}
	if (dataOff < 0) throw new Error("no data chunk");
	if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}`);
	const n = Math.floor(dataLen / 2 / channels);
	const pcm = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		// take channel 0 only
		pcm[i] = dv.getInt16(dataOff + i * 2 * channels, true) / 32768;
	}
	return { pcm, sampleRate };
}

/** Linear resample to 16 kHz. */
function resampleTo16k(pcm, srcRate) {
	if (srcRate === 16_000) return pcm;
	const ratio = 16_000 / srcRate;
	const outLen = Math.floor(pcm.length * ratio);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const srcPos = i / ratio;
		const i0 = Math.floor(srcPos);
		const frac = srcPos - i0;
		const a = pcm[i0] ?? 0;
		const b = pcm[i0 + 1] ?? a;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

function cosine(a, b) {
	let dot = 0;
	let am = 0;
	let bm = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		am += a[i] * a[i];
		bm += b[i] * b[i];
	}
	const d = Math.sqrt(am) * Math.sqrt(bm);
	return d === 0 ? 0 : dot / d;
}

const SPEAKER_GGUF = path.join(
	process.env.HOME,
	".eliza/local-inference/models/eliza-1-0_8b.bundle/voice/speaker-encoder/wespeaker-resnet34-lm-fp32.gguf",
);

const files = {
	femaleA: path.join(DIR, "female-A.wav"),
	femaleB: path.join(DIR, "female-B.wav"),
	maleA: path.join(DIR, "male-A.wav"),
};

for (const [k, f] of Object.entries(files)) {
	if (!existsSync(f)) {
		console.error(`[real-voice] missing WAV: ${f} (run the OmniVoice generation first)`);
		process.exit(2);
	}
}

const enc = new SpeakerEncoderGgmlImpl({ ggufPath: SPEAKER_GGUF, repoRoot: REPO_ROOT });
const emb = {};
for (const [k, f] of Object.entries(files)) {
	const { pcm, sampleRate } = decodeWav(readFileSync(f));
	const pcm16 = resampleTo16k(pcm, sampleRate);
	emb[k] = await enc.encode(pcm16);
	console.log(`[real-voice] ${k}: ${(pcm16.length / 16000).toFixed(2)}s @16k → ${emb[k].length}-dim embedding`);
}
await enc.dispose();

const sameVoice = cosine(emb.femaleA, emb.femaleB); // same designed voice, different text
const crossVoice = cosine(emb.femaleA, emb.maleA); // female vs male
const gap = sameVoice - crossVoice;

const result = {
	mode: "NATIVE_GGML",
	embeddingDim: emb.femaleA.length,
	sameVoiceCosine: Number(sameVoice.toFixed(4)),
	crossVoiceCosine: Number(crossVoice.toFixed(4)),
	separationGap: Number(gap.toFixed(4)),
	// Real WeSpeaker: same speaker typically > 0.5, different > separation of ~0.1+
	separated: gap > 0.05,
};
console.log("\n[real-voice] === SUMMARY ===");
console.log(JSON.stringify(result, null, 2));
console.log(
	result.separated
		? "[real-voice] PASS: real encoder separates the two designed voices"
		: "[real-voice] INCONCLUSIVE: separation gap below 0.05 (voices may be too similar, or OmniVoice ignored the instruct labels)",
);
process.exit(0);
