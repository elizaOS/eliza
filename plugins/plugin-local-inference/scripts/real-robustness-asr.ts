#!/usr/bin/env bun
/**
 * Real ASR WER under acoustic degradation — REAL speech + REAL models (#8785).
 *
 * The headline robustness validation: synthesize natural speech (ElevenLabs),
 * apply each degradation from the corpus DSP (`corpus-augment`: noise / reverb /
 * far-field / low-quality / combined), transcribe with the REAL on-device ASR
 * (eliza-1-asr via the fused lib + Metal), and report real WER per condition.
 * This is "real WER on the degraded corpus" — proving the robustness corpus is
 * meaningful and showing how the real ASR holds up as the room gets worse.
 *
 * Inputs (env): ELIZA_INFERENCE_LIBRARY, ELIZA_ASR_BUNDLE, ELEVENLABS_API_KEY.
 * Exits 2 (skip) when an artifact/key is missing.
 */

import { existsSync } from "node:fs";
import { wordErrorRate } from "@elizaos/shared/voice-wer";
import { type AugmentationSpec, augmentPcm } from "../src/services/voice/corpus-augment";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";

const EL_VOICE = "21m00Tcm4TlvDq8ikWAM";
const SR = 16_000;

const PHRASES = [
	"What time is it right now in San Francisco",
	"Set a timer for ten minutes please",
	"Add milk and eggs to the shopping list",
];

const CONDITIONS: Array<{ name: string; spec: AugmentationSpec }> = [
	{ name: "clean", spec: {} },
	{ name: "noise 10dB", spec: { noiseSnrDb: 10, noiseKind: "pink", seed: 1 } },
	{ name: "noise 5dB", spec: { noiseSnrDb: 5, noiseKind: "pink", seed: 1 } },
	{ name: "reverb 0.7", spec: { reverb: 0.7, seed: 1 } },
	{ name: "far-field 12dB", spec: { farFieldDb: 12, reverb: 0.4, noiseSnrDb: 14, seed: 1 } },
	{ name: "low-quality", spec: { lowQuality: true } },
	{ name: "harsh (all)", spec: { noiseSnrDb: 6, reverb: 0.6, farFieldDb: 9, lowQuality: true, seed: 1 } },
	// Destructive levels — confirm the test discriminates + find the breaking point.
	{ name: "noise 0dB", spec: { noiseSnrDb: 0, noiseKind: "white", seed: 1 } },
	{ name: "noise -6dB", spec: { noiseSnrDb: -6, noiseKind: "white", seed: 1 } },
	{ name: "reverb 0.98", spec: { reverb: 0.98, reverbWet: 0.9, seed: 1 } },
	{ name: "destroyed", spec: { noiseSnrDb: -3, reverb: 0.9, farFieldDb: 24, lowQuality: true, seed: 1 } },
];

function skip(m: string): never {
	console.log(`[real-robustness] SKIP: ${m}`);
	process.exit(2);
}

const lib = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
const bundle = process.env.ELIZA_ASR_BUNDLE?.trim();
const elKey = process.env.ELEVENLABS_API_KEY?.trim();
if (!lib || !existsSync(lib)) skip("set ELIZA_INFERENCE_LIBRARY");
if (!bundle || !existsSync(`${bundle}/asr`)) skip("set ELIZA_ASR_BUNDLE");
if (!elKey) skip("set ELEVENLABS_API_KEY");

/** ElevenLabs TTS → raw mono PCM16 @16k → normalized Float32 [-1,1]. */
async function ttsFloat32(text: string): Promise<Float32Array> {
	const r = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}?output_format=pcm_16000`,
		{
			method: "POST",
			headers: { "xi-api-key": elKey!, "content-type": "application/json" },
			body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
		},
	);
	if (!r.ok) skip(`ElevenLabs TTS ${r.status}: ${(await r.text()).slice(0, 160)}`);
	const bytes = new Uint8Array(await r.arrayBuffer());
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const n = Math.floor(bytes.length / 2);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
	return out;
}

const ffi = loadElizaInferenceFfi(lib);
const ctx = ffi.create(bundle);
ffi.mmapAcquire(ctx, "asr");

// rows[condition] = list of WER across phrases
const rows = new Map<string, number[]>();
try {
	for (const phrase of PHRASES) {
		const clean = await ttsFloat32(phrase);
		for (const cond of CONDITIONS) {
			const pcm =
				Object.keys(cond.spec).length === 0
					? clean
					: augmentPcm(clean, SR, cond.spec, {});
			const { text } = ffi.asrTranscribeTimed({ ctx, pcm, sampleRateHz: SR });
			const wer = wordErrorRate(phrase, (text ?? "").trim());
			let arr = rows.get(cond.name);
			if (!arr) {
				arr = [];
				rows.set(cond.name, arr);
			}
			arr.push(wer);
			console.log(
				`  ${cond.name.padEnd(16)} WER=${wer.toFixed(2)}  "${(text ?? "").trim().slice(0, 70)}"`,
			);
		}
		console.log("");
	}
} finally {
	ffi.mmapEvict(ctx, "asr");
	ffi.destroy(ctx);
	ffi.close();
}

console.log("[real-robustness] ── mean WER by condition (real eliza-1-asr) ──");
for (const cond of CONDITIONS) {
	const arr = rows.get(cond.name) ?? [];
	const mean = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : Number.NaN;
	console.log(`  ${cond.name.padEnd(16)} mean WER = ${mean.toFixed(3)}  (n=${arr.length})`);
}
console.log("[real-robustness] done");
