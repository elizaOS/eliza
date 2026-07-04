#!/usr/bin/env bun
/**
 * Real ASR smoke — the RUNNABLE post-merge STT lane.
 *
 * vitest workers don't run the bun runtime, so the bun:ffi `*.real.test.ts`
 * suites skip there and the "real STT lane" historically proved nothing. This
 * script runs under bun directly: it loads the fused `libelizainference`,
 * transcribes a real-speech WAV, and asserts a non-empty, MULTI-SENTENCE
 * transcript — which also guards the ASR sentence-final early-stop regression
 * (that bug truncated multi-sentence audio to its first clause).
 *
 * Exits 0 on pass, 1 on failure, 2 when the lib/bundle/audio aren't staged (so
 * a developer box without the models is skipped, but a CI lane that staged them
 * and then produced a bad transcript goes RED).
 *
 * Inputs (env):
 *   ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR  — fused lib (else the
 *     <stateDir>/local-inference/lib default from stage-desktop-fused-lib.mjs)
 *   ELIZA_ASR_BUNDLE  — a bundle dir with asr/eliza-1-asr.gguf + -mmproj.gguf
 *   ELIZA_ASR_WAV     — override the test audio (default: bundled freeman.wav)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFusedLibraryPath } from "../src/services/desktop-fused-ffi-backend-runtime";
import { decodeMonoPcm16Wav } from "../src/services/voice/engine-bridge";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function skip(msg: string): never {
	console.log(`[asr-real-smoke] SKIP: ${msg}`);
	process.exit(2);
}
function fail(msg: string): never {
	console.error(`[asr-real-smoke] FAIL: ${msg}`);
	process.exit(1);
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
	skip("not running under bun (bun:ffi required) — invoke with `bun`");
}

const libPath = resolveFusedLibraryPath(null, process.env);
if (!libPath) {
	skip(
		"fused lib not found (set ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR, " +
			"or run `bun run build:fused-desktop` in packages/app-core)",
	);
}

const bundle = process.env.ELIZA_ASR_BUNDLE?.trim();
if (!bundle || !existsSync(path.join(bundle, "asr"))) {
	skip(
		"no ASR bundle (set ELIZA_ASR_BUNDLE to a dir with asr/eliza-1-asr.gguf + -mmproj.gguf)",
	);
}

const wav =
	process.env.ELIZA_ASR_WAV?.trim() ||
	path.resolve(
		__dirname,
		"../native/audio-fixtures/freeman.wav",
	);
if (!existsSync(wav)) skip(`test audio not found at ${wav} (set ELIZA_ASR_WAV)`);

console.log(`[asr-real-smoke] lib=${libPath}`);
console.log(`[asr-real-smoke] bundle=${bundle}`);
console.log(`[asr-real-smoke] audio=${wav}`);

const ffi = loadElizaInferenceFfi(libPath);
if (ffi.libraryAbiVersion !== "12") {
	fail(`expected ABI v12, got ${ffi.libraryAbiVersion}`);
}
const ctx = ffi.create(bundle);
ffi.mmapAcquire(ctx, "asr");
try {
	const { pcm, sampleRate } = decodeMonoPcm16Wav(new Uint8Array(readFileSync(wav)));
	const t0 = performance.now();
	const { text, words } = ffi.asrTranscribeTimed({
		ctx,
		pcm,
		sampleRateHz: sampleRate,
	});
	const ms = Math.round(performance.now() - t0);
	const trimmed = (text ?? "").trim();
	const sentenceCount = (trimmed.match(/[.?!]/g) ?? []).length;
	console.log(`[asr-real-smoke] (${ms}ms) "${trimmed}"`);
	console.log(
		`[asr-real-smoke] words=${words?.length ?? 0} sentences≈${sentenceCount}`,
	);

	if (trimmed.length === 0) fail("empty transcript");
	if ((words?.length ?? 0) < 5) fail(`too few words (${words?.length ?? 0})`);
	// freeman.wav is several sentences. >=2 sentence-final marks proves the
	// decode loop runs to completion rather than early-stopping at the first
	// '.'/'?'/'!'.
	if (sentenceCount < 2) {
		fail(
			`transcript has ${sentenceCount} sentence-final marks — looks truncated ` +
				`(ASR early-stop regression?)`,
		);
	}
	console.log("[asr-real-smoke] PASS");
} finally {
	ffi.mmapEvict(ctx, "asr");
	ffi.destroy(ctx);
	ffi.close();
}
