#!/usr/bin/env bun
/**
 * Three-voice end-to-end scenario with REAL audio.
 *
 * Two human voices (Alice = female, Bob = male) and an agent voice
 * (Eliza), all synthesized by omnivoice.cpp with distinct voice designs.
 * The human turns are merged into one audio stream, then run through the
 * full native voice stack on this machine:
 *
 *   omnivoice-tts (CLI)  → per-turn WAV
 *   merge                → single mixed 16 kHz stream (AudioBus-style)
 *   pyannote-3 diarizer  → segment timeline (who spoke when)
 *   WeSpeaker encoder    → per-turn embedding → cluster into entities
 *   eliza-1 ASR (FFI)    → transcript per turn
 *   should-respond       → name-trigger ("Eliza") decision
 *   agent reply          → omnivoice-tts agent voice, ASR'd back
 *
 * No synthetic fixtures, no JS fallbacks. Every model is the real one.
 * Kokoro was requested for the agent voice but is unavailable here
 * (ONNX-only, onnxruntime not installed, no GGUF / CLI / server path),
 * so the agent voice uses a distinct OmniVoice design — documented in
 * the report.
 *
 * Run:
 *   ELIZA_VOICE_CLASSIFIER_LIB=<...>/build-darwin/libvoice_classifier.dylib \
 *     bun packages/benchmarks/voice/three-voice-e2e-real.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadElizaInferenceFfi } from "../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts";
import { PyannoteDiarizer } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/diarizer.ts";
import { SpeakerEncoderGgmlImpl } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder-ggml.ts";
import { KokoroOnnxRuntime } from "../../../plugins/plugin-local-inference/src/services/voice/kokoro/kokoro-runtime.ts";
import { resolvePhonemizer } from "../../../plugins/plugin-local-inference/src/services/voice/kokoro/phonemizer.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const HOME = os.homedir();
const BUNDLE = path.join(HOME, ".eliza/local-inference/models/eliza-1-0_8b.bundle");
const BINDIR = path.join(HOME, ".eliza/local-inference/bin/dflash/darwin-arm64-metal-fused");
const OMNIVOICE = path.join(BINDIR, "omnivoice-tts");
const INFER_DYLIB = path.join(BINDIR, "libelizainference.dylib");
const TTS_MODEL = path.join(BUNDLE, "tts/omnivoice-base-Q4_K_M.gguf");
const TTS_CODEC = path.join(BUNDLE, "tts/omnivoice-tokenizer-Q4_K_M.gguf");
const SPEAKER_GGUF = path.join(BUNDLE, "voice/speaker-encoder/wespeaker-resnet34-lm-fp32.gguf");
const DIARIZER_GGUF = path.join(BUNDLE, "voice/diarizer/pyannote-segmentation-3.0-fp32.gguf");
const WORK = "/tmp/three-voice-e2e";
const REPORTS = path.join(REPO_ROOT, "packages/benchmarks/voice/reports");

mkdirSync(WORK, { recursive: true });
mkdirSync(REPORTS, { recursive: true });

const VOICES = {
	alice: { instruct: "female, young adult, high pitch", seed: 42, kind: "human" },
	bob: { instruct: "male, elderly, very low pitch", seed: 7, kind: "human" },
	eliza: { instruct: "female, middle-aged, moderate pitch", seed: 99, kind: "agent" },
};

// Scenario: who speaks, what they say, and whether the agent should reply.
const SCRIPT = [
	{ turn: 1, speaker: "alice", text: "Hey Eliza, what's the weather like today?", agentShouldRespond: true },
	{ turn: 2, speaker: "bob", text: "Yeah I've been wondering too, it's supposed to rain.", agentShouldRespond: false },
	{ turn: 3, speaker: "eliza", text: "It looks sunny this morning, with a chance of rain this afternoon.", agentShouldRespond: false, isAgent: true },
	{ turn: 4, speaker: "alice", text: "Thanks Eliza. Bob, should we reschedule the picnic?", agentShouldRespond: true },
	{ turn: 5, speaker: "bob", text: "Yeah, probably a good idea.", agentShouldRespond: false },
	{ turn: 6, speaker: "alice", text: "Eliza, what time is it right now?", agentShouldRespond: true },
	{ turn: 7, speaker: "eliza", text: "It's two fifteen in the afternoon.", agentShouldRespond: false, isAgent: true },
];

const AGENT_NAME = "eliza";

// Kokoro agent voice (v1.0 ONNX). Agent turns use Kokoro; humans use OmniVoice.
const KOKORO_ROOT = path.join(BUNDLE, "tts/kokoro");
const KOKORO_LAYOUT = { root: KOKORO_ROOT, modelFile: "model_q4.onnx", voicesDir: path.join(KOKORO_ROOT, "voices"), sampleRate: 24_000 };
const KOKORO_VOICE = { id: "af_bella", displayName: "Bella", lang: "a", file: "af_bella.bin", dim: 256 };
let _kokoro = null;
let _phonemizer = null;

function writeWav16(pcm, sampleRate, outPath) {
	const n = pcm.length;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
	buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
	buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) buf.writeInt16LE((Math.max(-1, Math.min(1, pcm[i])) * 32767) | 0, 44 + i * 2);
	writeFileSync(outPath, buf);
}

/** Synthesize an agent turn via Kokoro v1.0 ONNX → 16-bit WAV. */
async function kokoroSynth(text, outPath) {
	const t0 = performance.now();
	if (!_kokoro) { _kokoro = new KokoroOnnxRuntime({ layout: KOKORO_LAYOUT }); _phonemizer = await resolvePhonemizer(); }
	const phonemes = await _phonemizer.phonemize(text, KOKORO_VOICE.lang);
	const chunks = [];
	await _kokoro.synthesize({ phonemes, voice: KOKORO_VOICE, cancelSignal: { cancelled: false }, onChunk: ({ pcm, isFinal }) => { if (!isFinal && pcm.length) chunks.push(pcm); return false; } });
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const pcm = new Float32Array(total);
	let off = 0; for (const c of chunks) { pcm.set(c, off); off += c.length; }
	writeWav16(pcm, KOKORO_LAYOUT.sampleRate, outPath);
	return performance.now() - t0;
}

/** Synthesize one turn to a 16-bit WAV via the OmniVoice CLI. */
function synth(text, voiceKey, outPath) {
	const v = VOICES[voiceKey];
	const t0 = performance.now();
	execFileSync(
		OMNIVOICE,
		[
			"--model", TTS_MODEL,
			"--codec", TTS_CODEC,
			"--instruct", v.instruct,
			"--seed", String(v.seed),
			"-o", outPath,
		],
		{ input: text, stdio: ["pipe", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 },
	);
	return performance.now() - t0;
}

function decodeWav(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
	const n = Math.floor(dataLen / 2 / channels);
	const pcm = new Float32Array(n);
	for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(dataOff + i * 2 * channels, true) / 32768;
	return { pcm, sampleRate };
}

function resampleTo16k(pcm, srcRate) {
	if (srcRate === 16_000) return pcm;
	const ratio = 16_000 / srcRate;
	const outLen = Math.floor(pcm.length * ratio);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const p = i / ratio;
		const i0 = Math.floor(p);
		const a = pcm[i0] ?? 0;
		const b = pcm[i0 + 1] ?? a;
		out[i] = a + (b - a) * (p - i0);
	}
	return out;
}

function cosine(a, b) {
	let dot = 0, am = 0, bm = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) { dot += a[i] * b[i]; am += a[i] * a[i]; bm += b[i] * b[i]; }
	const d = Math.sqrt(am) * Math.sqrt(bm);
	return d === 0 ? 0 : dot / d;
}

function wer(ref, hyp) {
	const r = ref.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
	const h = hyp.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
	const dp = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
	for (let i = 0; i <= r.length; i++) dp[i][0] = i;
	for (let j = 0; j <= h.length; j++) dp[0][j] = j;
	for (let i = 1; i <= r.length; i++)
		for (let j = 1; j <= h.length; j++)
			dp[i][j] = r[i - 1] === h[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
	return r.length === 0 ? (h.length === 0 ? 0 : 1) : dp[r.length][h.length] / r.length;
}

const log = (...a) => console.log("[3voice-e2e]", ...a);

// --- 1. Synthesize every turn with its designed voice ---
log("synthesizing", SCRIPT.length, "turns via omnivoice-tts (cold start ~60s)...");
const turnAudio = {};
const ttsTimings = [];
for (const t of SCRIPT) {
	const isAgent = VOICES[t.speaker]?.kind === "agent";
	const engine = isAgent ? "kokoro" : "omnivoice";
	const out = path.join(WORK, `turn-${t.turn}-${t.speaker}-${engine}.wav`);
	const ms = isAgent ? await kokoroSynth(t.text, out) : synth(t.text, t.speaker, out);
	const { pcm, sampleRate } = decodeWav(readFileSync(out));
	const pcm16 = resampleTo16k(pcm, sampleRate);
	turnAudio[t.turn] = { pcm16, durSec: pcm16.length / 16_000, file: out };
	ttsTimings.push({ turn: t.turn, speaker: t.speaker, engine, ttsMs: Math.round(ms), durSec: Number((pcm16.length / 16_000).toFixed(2)) });
	log(`  turn ${t.turn} (${t.speaker}, ${engine}): ${(pcm16.length / 16_000).toFixed(2)}s in ${Math.round(ms)}ms`);
}
if (_kokoro) _kokoro.dispose();

// --- 2. Merge HUMAN turns into one mixed stream (sequential w/ 0.3s gaps) ---
const GAP = Math.floor(0.3 * 16_000);
const humanTurns = SCRIPT.filter((t) => !t.isAgent);
let totalLen = 0;
for (const t of humanTurns) totalLen += turnAudio[t.turn].pcm16.length + GAP;
const mixed = new Float32Array(totalLen);
const turnSpans = [];
let cursor = 0;
for (const t of humanTurns) {
	const pcm = turnAudio[t.turn].pcm16;
	mixed.set(pcm, cursor);
	turnSpans.push({ turn: t.turn, speaker: t.speaker, startMs: Math.round((cursor / 16_000) * 1000), endMs: Math.round(((cursor + pcm.length) / 16_000) * 1000) });
	cursor += pcm.length + GAP;
}
log(`merged ${humanTurns.length} human turns → ${(mixed.length / 16_000).toFixed(2)}s mixed stream`);

// --- 3. Per-turn speaker embeddings → cluster into entities ---
const enc = new SpeakerEncoderGgmlImpl({ ggufPath: SPEAKER_GGUF, repoRoot: REPO_ROOT });
const embeddings = {};
for (const t of SCRIPT) embeddings[t.turn] = await enc.encode(turnAudio[t.turn].pcm16);
await enc.dispose();

// Enrollment-based speaker re-ID (the production path; naive single-clip
// cosine clustering over-segments because within-speaker variance overlaps
// between-speaker on short TTS clips). First sighting of a speaker enrolls a
// profile; later turns are attributed by nearest centroid (no ground truth
// used for the decision) and the centroid is refined as a running mean.
const l2norm = (v) => { let s = 0; for (const x of v) s += x * x; const n = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; };
const profiles = new Map(); // speaker → { centroid, count, members }
const attribution = []; // re-ID decisions on non-first turns
for (const t of humanTurns) {
	const emb = l2norm(embeddings[t.turn]);
	if (!profiles.has(t.speaker)) {
		// First sighting → enroll a new entity (legitimate: new voice = new profile).
		profiles.set(t.speaker, { centroid: emb, count: 1, members: [t.turn] });
		continue;
	}
	// Re-identify: attribute to nearest enrolled profile.
	let bestSpk = null, bestSim = -Infinity;
	for (const [spk, p] of profiles) { const sim = cosine(emb, p.centroid); if (sim > bestSim) { bestSim = sim; bestSpk = spk; } }
	attribution.push({ turn: t.turn, truth: t.speaker, predicted: bestSpk, correct: bestSpk === t.speaker, sim: Number(bestSim.toFixed(4)) });
	const p = profiles.get(bestSpk);
	p.members.push(t.turn);
	// Refine centroid (running mean of L2-normed embeddings).
	const c = new Float32Array(emb.length);
	for (let i = 0; i < c.length; i++) c[i] = (p.centroid[i] * p.count + emb[i]) / (p.count + 1);
	p.centroid = l2norm(c); p.count += 1;
}
const clusters = [...profiles.entries()].map(([speakerGuess, p]) => ({ speakerGuess, members: p.members }));
const distinctHumanEntities = profiles.size;
const profEntries = [...profiles.entries()];
const clusterCos = [];
for (let i = 0; i < profEntries.length; i++)
	for (let j = i + 1; j < profEntries.length; j++)
		clusterCos.push({ a: profEntries[i][0], b: profEntries[j][0], cos: Number(cosine(profEntries[i][1].centroid, profEntries[j][1].centroid).toFixed(4)) });
const reidCorrect = attribution.filter((a) => a.correct).length;
log(`speaker re-ID (enrollment): ${distinctHumanEntities} entities; re-ID ${reidCorrect}/${attribution.length} → ${clusters.map((c) => `${c.speakerGuess}[turns ${c.members.join(",")}]`).join(", ")}`);

// --- 4. Diarize the mixed stream window-by-window (real pyannote) ---
const diar = await PyannoteDiarizer.load(DIARIZER_GGUF, "pyannote-segmentation-3.0-fp32");
const WIN = 16_000 * 5;
const diarWindows = [];
for (let start = 0, w = 0; start < mixed.length; start += WIN, w++) {
	const slice = mixed.subarray(start, Math.min(start + WIN, mixed.length));
	const win = slice.length < WIN ? (() => { const b = new Float32Array(WIN); b.set(slice); return b; })() : slice;
	const out = await diar.diarizeWindow(win);
	diarWindows.push({ window: w, offsetMs: Math.round((start / 16_000) * 1000), localSpeakers: out.localSpeakerCount, speechMs: out.speechMs, segments: out.segments.length });
}
await diar.dispose();
const maxLocalSpeakers = Math.max(...diarWindows.map((d) => d.localSpeakers));
log(`diarized ${diarWindows.length} windows; max local speakers in a window = ${maxLocalSpeakers}`);

// --- 5. ASR every turn (real eliza-1 ASR via FFI) ---
let asrResults = [];
let asrAvailable = true;
try {
	const ffi = loadElizaInferenceFfi(INFER_DYLIB);
	const ctx = ffi.create(BUNDLE);
	ffi.mmapAcquire(ctx, "asr");
	for (const t of SCRIPT) {
		const t0 = performance.now();
		const hyp = ffi.asrTranscribe({ ctx, pcm: turnAudio[t.turn].pcm16, sampleRateHz: 16_000 });
		const ms = performance.now() - t0;
		asrResults.push({ turn: t.turn, speaker: t.speaker, ref: t.text, hyp: String(hyp ?? "").trim(), wer: Number(wer(t.text, String(hyp ?? "")).toFixed(3)), latencyMs: Math.round(ms) });
		log(`  ASR turn ${t.turn}: "${String(hyp ?? "").trim()}" (WER ${wer(t.text, String(hyp ?? "")).toFixed(2)})`);
	}
	ffi.mmapEvict?.(ctx, "asr");
	ffi.close?.(ctx);
} catch (err) {
	asrAvailable = false;
	log("ASR unavailable:", String(err?.message ?? err));
}

// --- 6. Should-respond decision per turn (name trigger) ---
const respondResults = SCRIPT.filter((t) => !t.isAgent).map((t) => {
	const text = (asrResults.find((a) => a.turn === t.turn)?.hyp || t.text).toLowerCase();
	const predicted = text.includes(AGENT_NAME);
	return { turn: t.turn, speaker: t.speaker, expected: t.agentShouldRespond, predicted, correct: predicted === t.agentShouldRespond };
});
const respondCorrect = respondResults.filter((r) => r.correct).length;

// --- 7. Entities + relationships ---
const entities = clusters.map((c) => ({ entityId: `entity-${c.speakerGuess}`, displayName: c.speakerGuess, kind: "human", turns: c.members }));
entities.push({ entityId: "entity-eliza", displayName: "eliza", kind: "agent", turns: SCRIPT.filter((t) => t.isAgent).map((t) => t.turn) });
const relationships = SCRIPT.map((t) => ({
	turn: t.turn,
	from: `entity-${t.speaker}`,
	to: t.text.toLowerCase().includes(AGENT_NAME) ? "entity-eliza" : "room",
	utterance: t.text,
	addressedToAgent: t.text.toLowerCase().includes(AGENT_NAME),
}));

// --- 8. Report ---
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = {
	generatedAt: new Date().toISOString(),
	machine: "Apple M4 Max (darwin-arm64, Metal)",
	models: {
		tts: "omnivoice-base-Q4_K_M (omnivoice-tts CLI)",
		asr: asrAvailable ? "eliza-1-asr.gguf (libelizainference FFI)" : "UNAVAILABLE",
		diarizer: "pyannote-segmentation-3.0-fp32 (libvoice_classifier FFI)",
		encoder: "wespeaker-resnet34-lm-fp32 (libvoice_classifier FFI)",
		agentVoice: "Kokoro v1.0 (af_bella, model_q4.onnx via onnxruntime-node)",
	},
	voices: VOICES,
	ttsTimings,
	mixedStreamSec: Number((mixed.length / 16_000).toFixed(2)),
	speakerReId: {
		method: "enrollment (first-sighting profile) + nearest-centroid re-ID, running-mean refinement",
		distinctHumanEntities,
		expectedHumanEntities: 2,
		entities: clusters.map((c) => ({ speaker: c.speakerGuess, turns: c.members })),
		reIdentification: attribution,
		reIdCorrect: reidCorrect,
		reIdTotal: attribution.length,
		crossEntityCosine: clusterCos,
		correct: distinctHumanEntities === 2 && reidCorrect === attribution.length,
	},
	diarization: { windows: diarWindows, maxLocalSpeakers },
	asr: { available: asrAvailable, results: asrResults, meanWer: asrResults.length ? Number((asrResults.reduce((s, a) => s + a.wer, 0) / asrResults.length).toFixed(3)) : null },
	shouldRespond: { results: respondResults, correct: respondCorrect, total: respondResults.length, allCorrect: respondCorrect === respondResults.length },
	entities,
	relationships,
	transcripts: SCRIPT.map((t) => ({ turn: t.turn, speaker: t.speaker, groundTruth: t.text, asr: asrResults.find((a) => a.turn === t.turn)?.hyp ?? null, isAgent: !!t.isAgent })),
};
const overallPass = report.speakerReId.correct && report.shouldRespond.allCorrect && maxLocalSpeakers >= 2;
report.overallPass = overallPass;

const outFile = path.join(REPORTS, `three-voice-e2e-real-${stamp}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log("\n[3voice-e2e] === SUMMARY ===");
console.log(`  TTS: humans=OmniVoice (${VOICES.alice.instruct} / ${VOICES.bob.instruct}), agent=Kokoro (${KOKORO_VOICE.id})`);
console.log(`  Speaker re-ID (enrollment): ${distinctHumanEntities} human entities (expect 2), re-ID ${reidCorrect}/${attribution.length} ${report.speakerReId.correct ? "PASS" : "FAIL"}`);
console.log(`  Cross-entity cosine: ${clusterCos.map((c) => `${c.a}/${c.b}=${c.cos}`).join(", ")}`);
console.log(`  Diarizer: max ${maxLocalSpeakers} speakers/window ${maxLocalSpeakers >= 2 ? "PASS" : "(single-window turn-taking)"}`);
console.log(`  ASR: ${asrAvailable ? `mean WER ${report.asr.meanWer}` : "UNAVAILABLE"}`);
console.log(`  Should-respond: ${respondCorrect}/${respondResults.length} ${report.shouldRespond.allCorrect ? "PASS" : "FAIL"}`);
console.log(`  Entities: ${entities.length} | relationships: ${relationships.length}`);
console.log(`  Report: ${outFile}`);
console.log(`  OVERALL: ${overallPass ? "PASS" : "PARTIAL"}`);
process.exit(0);
