#!/usr/bin/env bun
/**
 * Real native-GGML verification: loads the WeSpeaker ResNet34-LM speaker
 * encoder and the pyannote-segmentation-3.0 diarizer through bun:ffi
 * (libvoice_classifier) against the GGUF models installed in the 0_8b
 * bundle. No synthetic-label fallback — if the native forward pass is
 * unavailable this script reports the failure rather than fabricating
 * results.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeSpeechWithSilenceFixture } from "../../../plugins/plugin-local-inference/src/services/voice/__test-helpers__/synthetic-speech.ts";
import { SpeakerEncoderGgmlImpl } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder-ggml.ts";
import { PyannoteDiarizer } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/diarizer.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const BUNDLE = path.join(
	os.homedir(),
	".eliza/local-inference/models/eliza-1-0_8b.bundle",
);
const SPEAKER_GGUF = path.join(
	BUNDLE,
	"voice/speaker-encoder/wespeaker-resnet34-lm-fp32.gguf",
);
const DIARIZER_GGUF = path.join(
	BUNDLE,
	"voice/diarizer/pyannote-segmentation-3.0-fp32.gguf",
);

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

/** Concatenate a speech fixture into a 5s window (pyannote window length). */
function speechWindow(seed, f0Hint) {
	const fx = makeSpeechWithSilenceFixture({
		sampleRate: 16_000,
		leadSilenceSec: 0.2,
		speechSec: 4.6,
		tailSilenceSec: 0.2,
		seed,
	});
	return fx.pcm;
}

const results = { speakerEncoder: {}, diarizer: {}, pass: true, failures: [] };

console.log("[verify-native-ggml] repo root:", REPO_ROOT);
console.log("[verify-native-ggml] speaker GGUF present:", existsSync(SPEAKER_GGUF));
console.log("[verify-native-ggml] diarizer GGUF present:", existsSync(DIARIZER_GGUF));

// --- Speaker encoder: real WeSpeaker embeddings ---
try {
	const enc = new SpeakerEncoderGgmlImpl({
		ggufPath: SPEAKER_GGUF,
		repoRoot: REPO_ROOT,
	});
	const ownerA = await enc.encode(speechWindow(0x1111));
	const ownerB = await enc.encode(speechWindow(0x2222));
	const attacker = await enc.encode(speechWindow(0x9999));
	await enc.dispose();

	const ownerSelf = cosine(ownerA, ownerB);
	const ownerVsAttacker = cosine(ownerA, attacker);
	results.speakerEncoder = {
		mode: "NATIVE_GGML",
		embeddingDim: ownerA.length,
		ownerIntraCosine: Number(ownerSelf.toFixed(4)),
		ownerVsAttackerCosine: Number(ownerVsAttacker.toFixed(4)),
		separationGap: Number((ownerSelf - ownerVsAttacker).toFixed(4)),
	};
	console.log("[verify-native-ggml] speaker encoder: NATIVE_GGML", results.speakerEncoder);
} catch (err) {
	results.speakerEncoder = { mode: "FAILED", error: String(err?.message ?? err) };
	results.pass = false;
	results.failures.push(`speaker-encoder: ${results.speakerEncoder.error}`);
	console.error("[verify-native-ggml] speaker encoder FAILED:", results.speakerEncoder.error);
}

// --- Diarizer: real pyannote-3 segmentation ---
try {
	const diar = await PyannoteDiarizer.load(
		DIARIZER_GGUF,
		"pyannote-segmentation-3.0-fp32",
	);
	// Build a 5s window with two speakers (front half / back half).
	const win = new Float32Array(16_000 * 5);
	const a = speechWindow(0x1111);
	const b = speechWindow(0x9999);
	const half = win.length >> 1;
	for (let i = 0; i < half && i < a.length; i++) win[i] = a[i];
	for (let i = 0; i < win.length - half && i < b.length; i++) win[half + i] = b[i];
	const out = await diar.diarizeWindow(win);
	await diar.dispose();
	results.diarizer = {
		mode: "NATIVE_GGML",
		localSpeakerCount: out.localSpeakerCount,
		speechMs: out.speechMs,
		segments: out.segments.length,
	};
	console.log("[verify-native-ggml] diarizer: NATIVE_GGML", results.diarizer);
} catch (err) {
	results.diarizer = { mode: "FAILED", error: String(err?.message ?? err) };
	results.pass = false;
	results.failures.push(`diarizer: ${results.diarizer.error}`);
	console.error("[verify-native-ggml] diarizer FAILED:", results.diarizer.error);
}

console.log("\n[verify-native-ggml] === SUMMARY ===");
console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
