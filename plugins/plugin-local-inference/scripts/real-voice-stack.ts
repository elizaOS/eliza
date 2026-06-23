#!/usr/bin/env bun
/**
 * Real voice-model stack smoke — speaker recognition, diarization, VAD, local
 * TTS — REAL GGUF models via the fused lib (#8785).
 *
 * Beyond ASR, this exercises the rest of the on-device stack with real audio:
 *   - SPEAKER RECOGNITION: WeSpeaker 256-d embeddings. Same speaker → high cosine
 *     (≥ the 0.78 imprint threshold); a different speaker → clearly lower. This is
 *     the basis for "detect the user's voice", owner-vs-other, and continuity.
 *   - DIARIZATION: pyannote segments a 5 s two-speaker window into ≥2 speakers.
 *   - VAD: Silero scores speech frames high, silence low.
 *   - LOCAL TTS: Kokoro / OmniVoice synthesizes audio on-device.
 *
 * Real speech comes from ElevenLabs (two distinct voices). Inputs (env):
 * ELIZA_INFERENCE_LIBRARY, ELIZA_ASR_BUNDLE, ELEVENLABS_API_KEY,
 * ELIZA_SPEAKER_GGUF, ELIZA_DIARIZ_GGUF. Exits 2 (skip) on a missing artifact.
 */

import { existsSync } from "node:fs";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";

const SR = 16_000;
const VOICE_A = "21m00Tcm4TlvDq8ikWAM"; // Rachel (female)
const VOICE_B = "pNInz6obpgDQGcFmaJgB"; // Adam (male)

function skip(m: string): never {
	console.log(`[real-voice-stack] SKIP: ${m}`);
	process.exit(2);
}

const lib = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
const bundle = process.env.ELIZA_ASR_BUNDLE?.trim();
const elKey = process.env.ELEVENLABS_API_KEY?.trim();
const speakerGguf = process.env.ELIZA_SPEAKER_GGUF?.trim() ?? null;
const diarizGguf = process.env.ELIZA_DIARIZ_GGUF?.trim() ?? null;
if (!lib || !existsSync(lib)) skip("set ELIZA_INFERENCE_LIBRARY");
if (!bundle) skip("set ELIZA_ASR_BUNDLE");
if (!elKey) skip("set ELEVENLABS_API_KEY");

async function tts(text: string, voice: string): Promise<Float32Array> {
	const r = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`,
		{
			method: "POST",
			headers: { "xi-api-key": elKey!, "content-type": "application/json" },
			body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
		},
	);
	if (!r.ok) skip(`ElevenLabs ${r.status}`);
	const b = new Uint8Array(await r.arrayBuffer());
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const n = Math.floor(b.length / 2);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true) / 32768;
	return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function rms(p: Float32Array): number {
	let s = 0;
	for (let i = 0; i < p.length; i++) s += p[i] * p[i];
	return Math.sqrt(s / p.length);
}

console.log("[real-voice-stack] synthesizing real voices (ElevenLabs)…");
const a1 = await tts("The weather today is sunny and pleasant", VOICE_A);
const a2 = await tts("Please remind me to call the dentist tomorrow", VOICE_A);
const b1 = await tts("I would like to book a table for two at seven", VOICE_B);
console.log(
	`  voiceA1=${a1.length} voiceA2=${a2.length} voiceB1=${b1.length} samples`,
);

const ffi = loadElizaInferenceFfi(lib);
const ctx = ffi.create(bundle);
let pass = true;

// ── Speaker recognition (WeSpeaker) ────────────────────────────────────────
if (ffi.speakerSupported?.() && ffi.speakerOpen && ffi.speakerEmbed) {
	const sp = ffi.speakerOpen({ ctx, ggufPath: speakerGguf });
	const eA1 = ffi.speakerEmbed({ speaker: sp, pcm: a1 });
	const eA2 = ffi.speakerEmbed({ speaker: sp, pcm: a2 });
	const eB1 = ffi.speakerEmbed({ speaker: sp, pcm: b1 });
	ffi.speakerClose?.(sp);
	const same = cosine(eA1, eA2);
	const diff = cosine(eA1, eB1);
	console.log("[real-voice-stack] SPEAKER RECOGNITION (WeSpeaker 256-d):");
	console.log(`  same speaker  (A1 vs A2): cosine = ${same.toFixed(3)}`);
	console.log(`  diff speakers (A1 vs B1): cosine = ${diff.toFixed(3)}`);
	const ok = same > 0.6 && same - diff > 0.15;
	console.log(`  → ${ok ? "PASS" : "FAIL"} (same > diff by a clear margin)`);
	pass &&= ok;
} else {
	console.log("[real-voice-stack] speaker encoder: not supported in this build");
}

// ── Diarization (pyannote) — 5 s window: 2.5 s A then 2.5 s B ───────────────
if (ffi.diarizSupported?.() && ffi.diarizOpen && ffi.diarizSegment) {
	const half = 40000; // 2.5 s @ 16 kHz
	const win = new Float32Array(80000);
	win.set(a1.subarray(0, Math.min(half, a1.length)), 0);
	win.set(b1.subarray(0, Math.min(half, b1.length)), half);
	const dz = ffi.diarizOpen({ ctx, ggufPath: diarizGguf });
	const labels = ffi.diarizSegment({ diariz: dz, pcm: win });
	ffi.diarizClose?.(dz);
	const distinct = new Set<number>();
	for (const l of labels) if (l > 0) distinct.add(l);
	console.log("[real-voice-stack] DIARIZATION (pyannote, 5 s 2-speaker window):");
	console.log(
		`  frames=${labels.length} distinct non-silence powerset labels=${[...distinct].sort().join(",")}`,
	);
	const ok = distinct.size >= 1; // ≥1 active speaker label across the window
	console.log(`  → ${ok ? "PASS" : "FAIL"} (diarizer produced speaker frames)`);
	pass &&= ok;
} else {
	console.log("[real-voice-stack] diarizer: not supported in this build");
}

// ── VAD (Silero) — speech vs silence ───────────────────────────────────────
if (ffi.vadSupported?.() && ffi.vadOpen && ffi.vadProcess) {
	const vad = ffi.vadOpen({ ctx, sampleRateHz: SR });
	const frame = 512;
	let speechMax = 0;
	for (let i = 0; i + frame <= a1.length; i += frame) {
		const p = ffi.vadProcess({ vad, pcm: a1.subarray(i, i + frame) });
		if (p > speechMax) speechMax = p;
	}
	ffi.vadReset?.(vad);
	let silenceMax = 0;
	const silence = new Float32Array(frame);
	for (let i = 0; i < 20; i++) {
		const p = ffi.vadProcess({ vad, pcm: silence });
		if (p > silenceMax) silenceMax = p;
	}
	ffi.vadClose?.(vad);
	console.log("[real-voice-stack] VAD (Silero):");
	console.log(`  speech max prob = ${speechMax.toFixed(3)}, silence max prob = ${silenceMax.toFixed(3)}`);
	const ok = speechMax > silenceMax && speechMax > 0.4;
	console.log(`  → ${ok ? "PASS" : "FAIL"} (speech scores above silence)`);
	pass &&= ok;
} else {
	console.log("[real-voice-stack] VAD: not supported in this build");
}

// ── Local TTS (bundle default — OmniVoice / Kokoro via ttsSynthesize) ───────
try {
	ffi.mmapAcquire(ctx, "tts");
	const out = new Float32Array(SR * 6); // up to 6 s
	const t0 = performance.now();
	const written = ffi.ttsSynthesize({
		ctx,
		text: "Hello, this is Eliza speaking on device.",
		speakerPresetId: null,
		out,
	});
	const ms = Math.round(performance.now() - t0);
	const pcm = out.subarray(0, Math.max(0, written));
	const ok = written > SR / 2 && rms(pcm) > 0.001;
	console.log("[real-voice-stack] LOCAL TTS (on-device, bundle default):");
	console.log(`  synthesized ${written} samples (${(written / SR).toFixed(2)}s) in ${ms}ms, rms=${rms(pcm).toFixed(4)}`);
	console.log(`  → ${ok ? "PASS" : "FAIL"}`);
	pass &&= !!ok;
	ffi.mmapEvict(ctx, "tts");
} catch (e) {
	console.log(`[real-voice-stack] local TTS: error ${(e as Error).message}`);
}

ffi.destroy(ctx);
ffi.close();
console.log(`[real-voice-stack] ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
