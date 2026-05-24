#!/usr/bin/env bun
/**
 * Kokoro agent-voice verification — the goal explicitly asks for the
 * agent to reply in a Kokoro TTS voice. This runs Kokoro v1.0 (ONNX
 * model_q4.onnx) via the in-repo KokoroOnnxRuntime with onnxruntime-node
 * (loadable under Bun) and the bundled ASCII fallback phonemizer (no
 * espeak-ng needed for ASCII agent lines). Each agent line is
 * synthesized, written to WAV, then run BACK through eliza-1 ASR to
 * prove the Kokoro audio is intelligible.
 *
 * Run:
 *   bun packages/benchmarks/voice/verify-kokoro-agent-voice.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadElizaInferenceFfi } from "../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts";
import { KokoroOnnxRuntime } from "../../../plugins/plugin-local-inference/src/services/voice/kokoro/kokoro-runtime.ts";
import { resolvePhonemizer } from "../../../plugins/plugin-local-inference/src/services/voice/kokoro/phonemizer.ts";

const HOME = os.homedir();
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const BUNDLE = path.join(HOME, ".eliza/local-inference/models/eliza-1-0_8b.bundle");
const KOKORO_ROOT = path.join(BUNDLE, "tts/kokoro");
const INFER_DYLIB = path.join(HOME, ".eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/libelizainference.dylib");
const WORK = "/tmp/three-voice-e2e";
const REPORTS = path.join(REPO_ROOT, "packages/benchmarks/voice/reports");
mkdirSync(WORK, { recursive: true });
mkdirSync(REPORTS, { recursive: true });

const layout = {
	root: KOKORO_ROOT,
	modelFile: "model_q4.onnx",
	voicesDir: path.join(KOKORO_ROOT, "voices"),
	sampleRate: 24_000,
};
// Agent voice = af_bella (American English female). Distinct, warm.
const AGENT_VOICE = { id: "af_bella", displayName: "Bella", lang: "a", file: "af_bella.bin", dim: 256 };

const AGENT_LINES = [
	{ turn: 3, text: "It looks sunny this morning, with a chance of rain this afternoon." },
	{ turn: 7, text: "It's two fifteen in the afternoon." },
];

function writeWav16(pcm, sampleRate, outPath) {
	const n = pcm.length;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
	buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
	buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) {
		let s = Math.max(-1, Math.min(1, pcm[i]));
		buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
	}
	writeFileSync(outPath, buf);
}

function resampleTo16k(pcm, srcRate) {
	if (srcRate === 16_000) return pcm;
	const ratio = 16_000 / srcRate;
	const out = new Float32Array(Math.floor(pcm.length * ratio));
	for (let i = 0; i < out.length; i++) { const p = i / ratio, i0 = Math.floor(p), a = pcm[i0] ?? 0, b = pcm[i0 + 1] ?? a; out[i] = a + (b - a) * (p - i0); }
	return out;
}

function wer(ref, hyp) {
	const r = ref.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
	const h = hyp.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
	const dp = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
	for (let i = 0; i <= r.length; i++) dp[i][0] = i;
	for (let j = 0; j <= h.length; j++) dp[0][j] = j;
	for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
		dp[i][j] = r[i - 1] === h[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
	return r.length === 0 ? 0 : dp[r.length][h.length] / r.length;
}

const log = (...a) => console.log("[kokoro-agent]", ...a);

if (!existsSync(path.join(layout.root, layout.modelFile))) { log("Kokoro ONNX missing:", layout.modelFile); process.exit(2); }
if (!existsSync(path.join(layout.voicesDir, AGENT_VOICE.file))) { log("voice pack missing:", AGENT_VOICE.file); process.exit(2); }

const runtime = new KokoroOnnxRuntime({ layout });
const phonemizer = await resolvePhonemizer();
log("phonemizer:", phonemizer.id, "| voice:", AGENT_VOICE.id);

const synth = [];
for (const line of AGENT_LINES) {
	const t0 = performance.now();
	const phonemes = await phonemizer.phonemize(line.text, AGENT_VOICE.lang);
	const chunks = [];
	await runtime.synthesize({
		phonemes,
		voice: AGENT_VOICE,
		cancelSignal: { cancelled: false },
		onChunk: ({ pcm, isFinal }) => { if (!isFinal && pcm.length) chunks.push(pcm); return false; },
	});
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const pcm = new Float32Array(total);
	let off = 0; for (const c of chunks) { pcm.set(c, off); off += c.length; }
	const ms = performance.now() - t0;
	const out = path.join(WORK, `agent-kokoro-turn-${line.turn}.wav`);
	writeWav16(pcm, layout.sampleRate, out);
	const durSec = pcm.length / layout.sampleRate;
	synth.push({ turn: line.turn, text: line.text, file: out, durSec: Number(durSec.toFixed(2)), wallMs: Math.round(ms), rtf: Number((ms / 1000 / durSec).toFixed(3)), phonemeIds: phonemes.ids.length, pcm16: resampleTo16k(pcm, layout.sampleRate) });
	log(`turn ${line.turn}: ${durSec.toFixed(2)}s in ${Math.round(ms)}ms (RTF ${(ms / 1000 / durSec).toFixed(2)}), ${phonemes.ids.length} phoneme ids → ${out}`);
}
runtime.dispose();

// ASR the Kokoro audio back to prove it is intelligible.
let asrOk = true;
const asr = [];
try {
	const ffi = loadElizaInferenceFfi(INFER_DYLIB);
	const ctx = ffi.create(BUNDLE);
	ffi.mmapAcquire(ctx, "asr");
	for (const s of synth) {
		const hyp = String(ffi.asrTranscribe({ ctx, pcm: s.pcm16, sampleRateHz: 16_000 }) ?? "").trim();
		const w = Number(wer(s.text, hyp).toFixed(3));
		asr.push({ turn: s.turn, ref: s.text, hyp, wer: w });
		log(`ASR turn ${s.turn}: "${hyp}" (WER ${w})`);
	}
	ffi.mmapEvict?.(ctx, "asr");
	ffi.close?.(ctx);
} catch (err) { asrOk = false; log("ASR unavailable:", String(err?.message ?? err)); }

const meanWer = asr.length ? Number((asr.reduce((s, a) => s + a.wer, 0) / asr.length).toFixed(3)) : null;
const report = {
	generatedAt: new Date().toISOString(),
	model: "Kokoro v1.0 (model_q4.onnx) via KokoroOnnxRuntime + onnxruntime-node",
	phonemizer: phonemizer.id,
	voice: AGENT_VOICE.id,
	synth: synth.map(({ pcm16, ...rest }) => rest),
	asr: { available: asrOk, results: asr, meanWer },
	pass: synth.every((s) => s.durSec > 0.3) && asrOk && (meanWer ?? 1) <= 0.5,
};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(path.join(REPORTS, `kokoro-agent-voice-${stamp}.json`), JSON.stringify(report, null, 2));

console.log("\n[kokoro-agent] === SUMMARY ===");
console.log(`  Kokoro generated ${synth.length} agent lines (voice ${AGENT_VOICE.id}, phonemizer ${phonemizer.id})`);
console.log(`  Audio: ${synth.map((s) => `T${s.turn}=${s.durSec}s@RTF${s.rtf}`).join(", ")}`);
console.log(`  ASR round-trip: ${asrOk ? `mean WER ${meanWer}` : "UNAVAILABLE"}`);
console.log(`  ${report.pass ? "PASS: Kokoro agent voice generates intelligible audio" : "PARTIAL — see report"}`);
process.exit(report.pass ? 0 : 1);
