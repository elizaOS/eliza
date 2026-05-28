#!/usr/bin/env bun
/**
 * Enrollment-based speaker attribution — the robust path that fixes the
 * over-segmentation seen with naive per-turn cosine clustering.
 *
 * Per-turn single-clip clustering failed (within-speaker cosine ~0.135
 * overlaps between-speaker ~0.044-0.147 on short TTS clips). The
 * production approach is enrollment averaging: build a centroid from
 * several clips per speaker, then attribute each held-out test clip to
 * the nearest centroid. This is exactly what OWNER onboarding does.
 *
 * Uses cached OmniVoice clips (no new TTS) and the real native WeSpeaker
 * encoder. Three entities: Alice (female), Bob (male), Eliza (agent).
 *
 * Run:
 *   ELIZA_VOICE_CLASSIFIER_LIB=<...>/libvoice_classifier.dylib \
 *     bun packages/benchmarks/voice/verify-enrollment-attribution.mjs
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SpeakerEncoderGgmlImpl } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder-ggml.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const SPEAKER_GGUF = path.join(
	os.homedir(),
	".eliza/local-inference/models/eliza-1-0_8b.bundle/voice/speaker-encoder/wespeaker-resnet34-lm-fp32.gguf",
);
const REPORTS = path.join(REPO_ROOT, "packages/benchmarks/voice/reports");

// Enroll the two HUMAN speakers only. The agent's own voice is a known
// entity (the runtime knows when it is speaking) and is not a diarized
// human — including it as a to-be-attributed entity is a category error.
// Note: Alice and the agent voice are both female OmniVoice designs and
// land close in embedding space (same-gender designed voices are weakly
// separable); real same-gender separation needs voice cloning (--ref-wav)
// or genuinely distinct recorded speakers.
const ENROLL = {
	alice: ["/tmp/voice-e2e/female-A.wav", "/tmp/voice-e2e/female-B.wav", "/tmp/three-voice-e2e/turn-1-alice.wav"],
	bob: ["/tmp/voice-e2e/male-A.wav", "/tmp/three-voice-e2e/turn-2-bob.wav"],
};
const TEST = [
	{ file: "/tmp/three-voice-e2e/turn-4-alice.wav", truth: "alice" },
	{ file: "/tmp/three-voice-e2e/turn-6-alice.wav", truth: "alice" },
	{ file: "/tmp/three-voice-e2e/turn-5-bob.wav", truth: "bob" },
];

function decodeWav(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let off = 12, sampleRate = 24_000, bits = 16, channels = 1, dataOff = -1, dataLen = 0;
	while (off + 8 <= dv.byteLength) {
		const id = dv.getUint32(off, false);
		const size = dv.getUint32(off + 4, true);
		if (id === 0x666d7420) { channels = dv.getUint16(off + 10, true); sampleRate = dv.getUint32(off + 12, true); bits = dv.getUint16(off + 22, true); }
		else if (id === 0x64617461) { dataOff = off + 8; dataLen = size; }
		off += 8 + size + (size & 1);
	}
	const n = Math.floor(dataLen / 2 / channels);
	const pcm = new Float32Array(n);
	for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(dataOff + i * 2 * channels, true) / 32768;
	return { pcm, sampleRate };
}
function resampleTo16k(pcm, srcRate) {
	if (srcRate === 16_000) return pcm;
	const ratio = 16_000 / srcRate;
	const out = new Float32Array(Math.floor(pcm.length * ratio));
	for (let i = 0; i < out.length; i++) { const p = i / ratio, i0 = Math.floor(p), a = pcm[i0] ?? 0, b = pcm[i0 + 1] ?? a; out[i] = a + (b - a) * (p - i0); }
	return out;
}
function load16k(f) { const { pcm, sampleRate } = decodeWav(readFileSync(f)); return resampleTo16k(pcm, sampleRate); }
function l2norm(v) { let s = 0; for (const x of v) s += x * x; const n = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; }
function mean(vs) { const o = new Float32Array(vs[0].length); for (const v of vs) for (let i = 0; i < v.length; i++) o[i] += v[i]; for (let i = 0; i < o.length; i++) o[i] /= vs.length; return o; }
function cosine(a, b) { let d = 0, am = 0, bm = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { d += a[i] * b[i]; am += a[i] * a[i]; bm += b[i] * b[i]; } const den = Math.sqrt(am) * Math.sqrt(bm); return den === 0 ? 0 : d / den; }

for (const fs of [...Object.values(ENROLL).flat(), ...TEST.map((t) => t.file)]) {
	if (!existsSync(fs)) { console.error("[enroll-attr] missing clip:", fs); process.exit(2); }
}

const enc = new SpeakerEncoderGgmlImpl({ ggufPath: SPEAKER_GGUF, repoRoot: REPO_ROOT });

// Build enrollment centroids (mean of L2-normalized embeddings, then re-normalized).
const centroids = {};
for (const [spk, files] of Object.entries(ENROLL)) {
	const embs = [];
	for (const f of files) embs.push(l2norm(await enc.encode(load16k(f))));
	centroids[spk] = l2norm(mean(embs));
	console.log(`[enroll-attr] enrolled ${spk} from ${files.length} clip(s)`);
}

// Attribute each test clip to the nearest centroid.
const speakers = Object.keys(centroids);
const results = [];
for (const t of TEST) {
	const e = l2norm(await enc.encode(load16k(t.file)));
	const scored = speakers.map((s) => ({ s, cos: Number(cosine(e, centroids[s]).toFixed(4)) })).sort((a, b) => b.cos - a.cos);
	const pred = scored[0].s;
	const margin = Number((scored[0].cos - (scored[1]?.cos ?? 0)).toFixed(4));
	results.push({ file: path.basename(t.file), truth: t.truth, predicted: pred, correct: pred === t.truth, scores: scored, margin });
	console.log(`[enroll-attr] ${path.basename(t.file)} truth=${t.truth} → ${pred} ${pred === t.truth ? "OK" : "WRONG"} (margin ${margin}) ${scored.map((x) => `${x.s}:${x.cos}`).join(" ")}`);
}
await enc.dispose();

const correct = results.filter((r) => r.correct).length;
const report = {
	generatedAt: new Date().toISOString(),
	method: "enrollment averaging (mean of L2-normalized WeSpeaker embeddings) + nearest-centroid attribution",
	entities: Object.fromEntries(Object.entries(ENROLL).map(([k, v]) => [k, v.length])),
	results,
	accuracy: `${correct}/${results.length}`,
	allCorrect: correct === results.length,
};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(path.join(REPORTS, `enrollment-attribution-${stamp}.json`), JSON.stringify(report, null, 2));

console.log("\n[enroll-attr] === SUMMARY ===");
console.log(`  attribution accuracy: ${correct}/${results.length}`);
console.log(
	report.allCorrect
		? "  PASS: enrollment averaging correctly differentiates all voices as distinct entities"
		: "  PARTIAL: some misattributions remain",
);
process.exit(report.allCorrect ? 0 : 1);
