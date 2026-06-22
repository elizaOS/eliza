#!/usr/bin/env bun
/**
 * Mixed local + cloud voice round-trip — REAL services, measured (#8785).
 *
 * Answers "can we mix local STT with the really fast cloud LLM?" with real
 * numbers. One utterance flows through:
 *
 *   cloud TTS (ElevenLabs, to make the question audio)
 *     → LOCAL STT  (eliza-1-asr via the fused libelizainference + Metal)
 *     → cloud LLM  (Cerebras — the fast inference)
 *     → cloud TTS  (ElevenLabs — spoken reply)
 *
 * and prints the per-stage latency + the hybrid time-to-first-audio. This is the
 * production "local STT + fast cloud LLM + cloud TTS" topology.
 *
 * Inputs (env): ELIZA_INFERENCE_LIBRARY (fused dylib), ELIZA_ASR_BUNDLE
 * (asr/eliza-1-asr.gguf), ELEVENLABS_API_KEY, CEREBRAS_API_KEY. Exits 2 (skip)
 * when an artifact/key is missing; 1 on failure; 0 on a clean round-trip.
 */

import { existsSync, readFileSync } from "node:fs";
import { decodeMonoPcm16Wav } from "../src/services/voice/engine-bridge";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";

const EL_VOICE = "21m00Tcm4TlvDq8ikWAM"; // a standard ElevenLabs voice
const QUESTION = "What time is it right now in San Francisco";

function skip(m: string): never {
	console.log(`[mixed-roundtrip] SKIP: ${m}`);
	process.exit(2);
}
function fail(m: string): never {
	console.error(`[mixed-roundtrip] FAIL: ${m}`);
	process.exit(1);
}

const lib = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
const bundle = process.env.ELIZA_ASR_BUNDLE?.trim();
const elKey = process.env.ELEVENLABS_API_KEY?.trim();
const cbKey = process.env.CEREBRAS_API_KEY?.trim();
if (!lib || !existsSync(lib)) skip("set ELIZA_INFERENCE_LIBRARY to the fused dylib");
if (!bundle || !existsSync(`${bundle}/asr`)) skip("set ELIZA_ASR_BUNDLE");
if (!elKey) skip("set ELEVENLABS_API_KEY");
if (!cbKey) skip("set CEREBRAS_API_KEY");

/** Wrap raw mono PCM16LE @ sampleRate in a 44-byte WAV header. */
function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
	const header = new ArrayBuffer(44);
	const v = new DataView(header);
	const w = (off: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
	};
	const byteRate = sampleRate * 2;
	w(0, "RIFF");
	v.setUint32(4, 36 + pcm.length, true);
	w(8, "WAVE");
	w(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, byteRate, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	w(36, "data");
	v.setUint32(40, pcm.length, true);
	const out = new Uint8Array(44 + pcm.length);
	out.set(new Uint8Array(header), 0);
	out.set(pcm, 44);
	return out;
}

async function elevenTts(text: string, fmt: string): Promise<Uint8Array> {
	const r = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}?output_format=${fmt}`,
		{
			method: "POST",
			headers: { "xi-api-key": elKey!, "content-type": "application/json" },
			body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
		},
	);
	if (!r.ok) fail(`ElevenLabs TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
	return new Uint8Array(await r.arrayBuffer());
}

async function cerebras(userText: string): Promise<string> {
	const r = await fetch("https://api.cerebras.ai/v1/chat/completions", {
		method: "POST",
		headers: { authorization: `Bearer ${cbKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: process.env.CEREBRAS_MODEL?.trim() || "gpt-oss-120b",
			// gpt-oss is a reasoning model — leave room for reasoning + the reply.
			max_tokens: 400,
			messages: [
				{
					role: "system",
					content: "You are a concise voice assistant. Reply in one short sentence.",
				},
				{ role: "user", content: userText },
			],
		}),
	});
	if (!r.ok) fail(`Cerebras ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = (await r.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	return (j.choices?.[0]?.message?.content ?? "").trim();
}

console.log(`[mixed-roundtrip] question: "${QUESTION}"`);

// 1) cloud TTS → raw 16 kHz PCM (the spoken question)
const t0 = performance.now();
const pcm16 = await elevenTts(QUESTION, "pcm_16000");
const tQ = Math.round(performance.now() - t0);
console.log(`[mixed-roundtrip] (cloud TTS question) ${tQ}ms, ${pcm16.length} bytes pcm`);

// 2) LOCAL STT via the fused engine + Metal
const ffi = loadElizaInferenceFfi(lib);
const ctx = ffi.create(bundle);
ffi.mmapAcquire(ctx, "asr");
let transcript = "";
let asrMs = 0;
try {
	const { pcm, sampleRate } = decodeMonoPcm16Wav(wavFromPcm16(pcm16, 16000));
	const a0 = performance.now();
	const res = ffi.asrTranscribeTimed({ ctx, pcm, sampleRateHz: sampleRate });
	asrMs = Math.round(performance.now() - a0);
	transcript = (res.text ?? "").trim();
} finally {
	ffi.mmapEvict(ctx, "asr");
	ffi.destroy(ctx);
	ffi.close();
}
console.log(`[mixed-roundtrip] (LOCAL STT, eliza-1-asr) ${asrMs}ms → "${transcript}"`);
if (!transcript) fail("local STT produced an empty transcript");

// 3) cloud LLM (Cerebras — fast)
const l0 = performance.now();
const reply = await cerebras(transcript);
const llmMs = Math.round(performance.now() - l0);
const cbModel = process.env.CEREBRAS_MODEL?.trim() || "gpt-oss-120b";
console.log(`[mixed-roundtrip] (cloud LLM, Cerebras ${cbModel}) ${llmMs}ms → "${reply}"`);
if (!reply) fail("LLM produced an empty reply");

// 4) cloud TTS (spoken reply) — measure to first audio bytes
const r0 = performance.now();
const replyAudio = await elevenTts(reply, "mp3_44100_128");
const ttsMs = Math.round(performance.now() - r0);
console.log(`[mixed-roundtrip] (cloud TTS reply) ${ttsMs}ms, ${replyAudio.length} bytes mp3`);

const hybridTtfa = asrMs + llmMs + ttsMs;
console.log("");
console.log("[mixed-roundtrip] ── latency breakdown (real services) ──");
console.log(`  local STT (eliza-1-asr + Metal):   ${asrMs} ms`);
console.log(`  cloud LLM (Cerebras):              ${llmMs} ms`);
console.log(`  cloud TTS (ElevenLabs first audio):${ttsMs} ms`);
console.log(`  ── hybrid round-trip (STT+LLM+TTS): ${hybridTtfa} ms`);
console.log("[mixed-roundtrip] PASS");
