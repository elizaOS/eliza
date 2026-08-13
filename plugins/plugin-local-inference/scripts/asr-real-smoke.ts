#!/usr/bin/env bun
/**
 * Real ASR smoke — the RUNNABLE post-merge STT lane.
 *
 * vitest workers don't run the bun runtime, so the bun:ffi `*.real.test.ts`
 * suites skip there and the "real STT lane" historically proved nothing. This
 * script runs under bun directly: it loads the fused `libelizainference`,
 * transcribes a real-speech WAV and checks it against a checked-in adjacent
 * reference with the shared word-error-rate metric. The accuracy gate also
 * catches the sentence-final early-stop regression that returned only the
 * clip's first clause.
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
 *   ELIZA_ASR_REFERENCE — override the reference transcript (default: the WAV
 *     path with its extension replaced by `.txt`)
 */

import { wordErrorRate } from "@elizaos/shared/voice-wer";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFusedLibraryPath } from "../src/services/desktop-fused-ffi-backend-runtime";
import {
	AsrSmokeFailure,
	failAsrSmoke,
	runAsrSmokeWithCleanup,
} from "../src/services/voice/asr-smoke-lifecycle";
import { decodeMonoPcm16Wav } from "../src/services/voice/engine-bridge";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";
import { VoiceLifecycleError } from "../src/services/voice/lifecycle";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function skip(msg: string): never {
	console.log(`[asr-real-smoke] SKIP: ${msg}`);
	process.exit(2);
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
const referencePath =
	process.env.ELIZA_ASR_REFERENCE?.trim() || wav.replace(/\.[^.]+$/, ".txt");
if (!existsSync(referencePath)) {
	skip(
		`reference transcript not found at ${referencePath} ` +
			"(set ELIZA_ASR_REFERENCE)",
	);
}
const reference = readFileSync(referencePath, "utf8").trim();
const MAX_WER = 0.2;

console.log(`[asr-real-smoke] lib=${libPath}`);
console.log(`[asr-real-smoke] bundle=${bundle}`);
console.log(`[asr-real-smoke] audio=${wav}`);
console.log(`[asr-real-smoke] reference=${referencePath}`);

const ffi = loadElizaInferenceFfi(libPath);
console.log(`[asr-real-smoke] compatible ABI v${ffi.libraryAbiVersion}`);
let cleanupOwnedBySmoke = false;
try {
	if (!ffi.timedAsrSupported()) {
		failAsrSmoke(`ABI v${ffi.libraryAbiVersion} does not provide timed ASR`);
	}
	cleanupOwnedBySmoke = true;
	runAsrSmokeWithCleanup({
		ffi,
		bundleDir: bundle,
		run: (ctx) => {
			const { pcm, sampleRate } = decodeMonoPcm16Wav(
				new Uint8Array(readFileSync(wav)),
			);
			const t0 = performance.now();
			const { text, words } = ffi.asrTranscribeTimed({
				ctx,
				pcm,
				sampleRateHz: sampleRate,
			});
			const ms = Math.round(performance.now() - t0);
			const trimmed = (text ?? "").trim();
			const wer = wordErrorRate(reference, trimmed);
			console.log(`[asr-real-smoke] (${ms}ms) "${trimmed}"`);
			console.log(
				`[asr-real-smoke] words=${words?.length ?? 0} WER=${wer.toFixed(4)} (max ${MAX_WER.toFixed(2)})`,
			);

			if (trimmed.length === 0) failAsrSmoke("empty transcript");
			if ((words?.length ?? 0) < 5) {
				failAsrSmoke(`too few words (${words?.length ?? 0})`);
			}
			if (wer > MAX_WER) {
				failAsrSmoke(
					`word error rate ${wer.toFixed(4)} exceeds ${MAX_WER.toFixed(2)}`,
				);
			}
			console.log("[asr-real-smoke] PASS");
		},
	});
} catch (error) {
	// error-policy:J1 CLI boundary translates an expected smoke failure to exit status.
	if (
		!(error instanceof AsrSmokeFailure) &&
		!(error instanceof VoiceLifecycleError)
	) {
		throw error;
	}
	console.error(`[asr-real-smoke] FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	if (!cleanupOwnedBySmoke) ffi.close();
}
