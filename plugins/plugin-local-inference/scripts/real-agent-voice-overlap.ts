#!/usr/bin/env bun
/**
 * Real agent-self-voice rejection + overlapping-speakers — real models (#8785).
 *
 * Answers two explicit asks with real audio + real models:
 *
 *   A) "How do we detect what the AGENT's voice sounds like, and reject it from
 *      going back into TTS?" — synthesize the agent's reply on-device (the real
 *      TTS), embed it with WeSpeaker, and show the agent's voice is (i) a
 *      consistent, recognizable speaker across different replies (self-voice
 *      continuity → an echo guard can match it), and (ii) clearly distinct from
 *      a human user. So `selfVoiceSimilarity` (the gate input we added) is real:
 *      an agent-echo turn matches the agent imprint and is suppressed.
 *
 *   B) Overlapping / interrupting speakers — mix two voices SIMULTANEOUSLY and
 *      confirm the pyannote diarizer flags overlap (powerset pair labels), the
 *      basis for "voices interrupting each other".
 *
 * Inputs (env): ELIZA_INFERENCE_LIBRARY, ELIZA_ASR_BUNDLE, ELEVENLABS_API_KEY,
 * ELIZA_SPEAKER_GGUF, ELIZA_DIARIZ_GGUF. Exits 2 (skip) on a missing artifact.
 */

import { existsSync } from "node:fs";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";

const SR = 16_000;
const VOICE_A = "21m00Tcm4TlvDq8ikWAM";
const VOICE_B = "pNInz6obpgDQGcFmaJgB";

function skip(m: string): never {
	console.log(`[agent-voice/overlap] SKIP: ${m}`);
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

const userA = await tts("Hey Eliza, what is on my calendar this afternoon", VOICE_A);
const userB = await tts("Could you turn the living room lights down a bit", VOICE_B);

const ffi = loadElizaInferenceFfi(lib);
const ctx = ffi.create(bundle);
let pass = true;

// On-device TTS → the AGENT's own voice, two different replies.
ffi.mmapAcquire(ctx, "tts");
function agentSay(text: string): Float32Array {
	const out = new Float32Array(SR * 8);
	const n = ffi.ttsSynthesize({ ctx, text, speakerPresetId: null, out });
	return out.subarray(0, Math.max(0, n));
}
const agent1 = agentSay("Your two o'clock meeting was moved to four.");
const agent2 = agentSay("The kitchen light is now set to thirty percent.");
ffi.mmapEvict(ctx, "tts");

// ── A) Agent self-voice: distinct + recognizable ───────────────────────────
if (ffi.speakerSupported?.() && ffi.speakerOpen && ffi.speakerEmbed) {
	const sp = ffi.speakerOpen({ ctx, ggufPath: speakerGguf });
	const eAgent1 = ffi.speakerEmbed({ speaker: sp, pcm: agent1 });
	const eAgent2 = ffi.speakerEmbed({ speaker: sp, pcm: agent2 });
	const eUserA = ffi.speakerEmbed({ speaker: sp, pcm: userA });
	const eUserB = ffi.speakerEmbed({ speaker: sp, pcm: userB });
	ffi.speakerClose?.(sp);
	const agentSelf = cosine(eAgent1, eAgent2);
	const agentVsUserA = cosine(eAgent1, eUserA);
	const agentVsUserB = cosine(eAgent1, eUserB);
	console.log("[agent-voice/overlap] A) AGENT SELF-VOICE (WeSpeaker):");
	console.log(`  agent vs agent (different replies): cosine = ${agentSelf.toFixed(3)}  ← self-voice imprint`);
	console.log(`  agent vs user A:                    cosine = ${agentVsUserA.toFixed(3)}`);
	console.log(`  agent vs user B:                    cosine = ${agentVsUserB.toFixed(3)}`);
	// The meaningful property for self-echo rejection: the agent's own voice is
	// MORE similar to itself than to any human, by a clear margin → an echo turn
	// (agent voice) sits above an agent imprint and below the human cohort, so
	// `selfVoiceSimilarity` separates it. (On-device TTS has more within-speaker
	// variation than a fixed human voice, so a voice centroid + the agentSpeaking
	// timing gate tighten this further in production — see VOICE_8785_ASSESSMENT.)
	const margin = agentSelf - Math.max(agentVsUserA, agentVsUserB);
	const ok = margin > 0.1;
	console.log(
		`  → ${ok ? "PASS" : "FAIL"} (agent self-similarity exceeds agent-vs-human by ${margin.toFixed(3)} → echo is rejectable)`,
	);
	pass &&= ok;
} else {
	console.log("[agent-voice/overlap] speaker encoder not supported");
}

// ── B) Overlapping speakers (interruption) ─────────────────────────────────
if (ffi.diarizSupported?.() && ffi.diarizOpen && ffi.diarizSegment) {
	// Build a 5 s window where A and B speak AT THE SAME TIME (overlap).
	const win = new Float32Array(80000);
	for (let i = 0; i < 80000; i++) {
		const a = i < userA.length ? userA[i] : 0;
		const b = i < userB.length ? userB[i] : 0;
		win[i] = Math.max(-1, Math.min(1, a * 0.7 + b * 0.7));
	}
	const dz = ffi.diarizOpen({ ctx, ggufPath: diarizGguf });
	const labels = ffi.diarizSegment({ diariz: dz, pcm: win });
	ffi.diarizClose?.(dz);
	// pyannote powerset: 0=silence, 1..3 single speakers, 4..6 overlap pairs.
	let overlapFrames = 0;
	const seen = new Set<number>();
	for (const l of labels) {
		if (l > 0) seen.add(l);
		if (l >= 4) overlapFrames += 1;
	}
	console.log("[agent-voice/overlap] B) OVERLAPPING SPEAKERS (pyannote):");
	console.log(
		`  labels seen=${[...seen].sort().join(",")}  overlap(≥4) frames=${overlapFrames}/${labels.length}`,
	);
	const ok = overlapFrames > 0 && [...seen].some((label) => label >= 4);
	console.log(
		`  → ${ok ? "PASS" : "FAIL"} (requires pyannote powerset overlap labels ≥4, not just any speech activity)`,
	);
	pass &&= ok;
} else {
	console.log("[agent-voice/overlap] diarizer not supported");
}

ffi.destroy(ctx);
ffi.close();
console.log(`[agent-voice/overlap] ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
