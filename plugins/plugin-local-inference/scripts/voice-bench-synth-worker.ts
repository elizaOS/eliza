#!/usr/bin/env bun
/**
 * One-utterance Kokoro synthesis worker for the #10726 bench corpus.
 *
 * The desktop-CPU Kokoro forward pass is effectively single-threaded, so
 * `voice-bench-shared.ts` fans utterances out across worker subprocesses.
 * Each worker loads the fused lib + Kokoro model, synthesizes ONE phrase with
 * an explicit voice, resamples 24 kHz → 16 kHz, and writes a mono PCM16 WAV.
 *
 * Args: --voice <voiceId> --out <wav path> --text-b64 <base64 utf8 text>
 * Env:  ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR, ELIZA_KOKORO_MODEL_DIR
 * Exit: 0 = WAV written; 1 = anything else (the parent treats it as FAIL).
 */

import { writeFileSync } from "node:fs";
import { resolveFusedLibraryPath } from "../src/services/desktop-fused-ffi-backend-runtime";
import {
	createKokoroTtsBackend,
	encodeMonoPcm16Wav,
} from "../src/services/voice/engine-bridge";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";
import { resolveKokoroEngineConfig } from "../src/services/voice/kokoro/kokoro-engine-discovery";
import { resampleLinear } from "../src/services/voice/transcriber";
import type { Phrase, SpeakerPreset } from "../src/services/voice/types";

function arg(name: string): string {
	const i = process.argv.indexOf(name);
	if (i < 0 || i + 1 >= process.argv.length) {
		console.error(`[synth-worker] missing ${name}`);
		process.exit(1);
	}
	return process.argv[i + 1];
}

const voiceId = arg("--voice");
const outPath = arg("--out");
const text = Buffer.from(arg("--text-b64"), "base64").toString("utf8");

const libPath = resolveFusedLibraryPath(null, process.env);
if (!libPath) {
	console.error("[synth-worker] fused lib not found");
	process.exit(1);
}
const ffi = loadElizaInferenceFfi(libPath);
if (!ffi.kokoroSupported()) {
	console.error("[synth-worker] fused lib does not link the Kokoro engine");
	process.exit(1);
}
const kokoro = resolveKokoroEngineConfig();
if (!kokoro) {
	console.error("[synth-worker] no Kokoro model staged (ELIZA_KOKORO_MODEL_DIR)");
	process.exit(1);
}

const backend = createKokoroTtsBackend(kokoro, { ffi });
const preset: SpeakerPreset = {
	voiceId,
	embedding: new Float32Array(0),
	bytes: new Uint8Array(0),
};
const phrase: Phrase = {
	id: 1,
	text,
	fromIndex: 0,
	toIndex: text.length,
	terminator: "punctuation",
};

try {
	const chunks: Float32Array[] = [];
	let sampleRate = 0;
	await backend.synthesizeStream({
		phrase,
		preset,
		cancelSignal: { cancelled: false },
		onChunk: (c) => {
			if (!c.isFinal && c.pcm.length > 0) {
				chunks.push(c.pcm);
				sampleRate = c.sampleRate;
			}
			return undefined;
		},
	});
	const total = chunks.reduce((a, c) => a + c.length, 0);
	if (total === 0 || sampleRate === 0) {
		console.error("[synth-worker] Kokoro produced no audio");
		process.exit(1);
	}
	const pcm = new Float32Array(total);
	let off = 0;
	for (const c of chunks) {
		pcm.set(c, off);
		off += c.length;
	}
	const pcm16k = resampleLinear(pcm, sampleRate, 16_000);
	writeFileSync(outPath, encodeMonoPcm16Wav(pcm16k, 16_000));
	process.exit(0);
} finally {
	backend.dispose();
}
