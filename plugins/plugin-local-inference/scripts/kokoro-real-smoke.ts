#!/usr/bin/env bun
/**
 * Real Kokoro TTS smoke — the RUNNABLE post-merge Kokoro-voice lane (#8787).
 *
 * vitest workers don't run the bun runtime, so the bun:ffi `*.real.test.ts`
 * suites skip there; and running them under `bun test` hits the repo's
 * coverage instrumentation, whose open file descriptors collide with the
 * 159 MB Kokoro GGUF mmap (`gguf_init_from_file ... Too many open files`).
 * This script runs under bun directly (no coverage harness): it loads the
 * fused `libelizainference`, loads the real Kokoro model, synthesizes a phrase,
 * and asserts non-empty 24 kHz PCM with a first-audible chunk inside the
 * mobile-class TTFA budget — the same in-process fused path mobile ships.
 *
 * Exits 0 on pass, 1 on a real failure, 2 when the lib/model aren't staged (a
 * developer box without them is skipped; a CI lane that staged them then
 * produced bad/slow audio goes RED).
 *
 * Inputs (env):
 *   ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR — fused lib (else the
 *     <stateDir>/local-inference/lib default from `build:fused-desktop`).
 *   ELIZA_KOKORO_MODEL_DIR — a dir with kokoro-82m-v1_0*.gguf + voices/<v>.bin
 *     (else <stateDir>/local-inference/models/kokoro).
 */

import { resolveFusedLibraryPath } from "../src/services/desktop-fused-ffi-backend-runtime";
import {
	createKokoroSpeakerPreset,
	createKokoroTtsBackend,
} from "../src/services/voice/engine-bridge";
import { loadElizaInferenceFfi } from "../src/services/voice/ffi-bindings";
import { KOKORO_MOBILE_TTFA_BUDGET_MS } from "../src/services/voice/kokoro/kokoro-backend";
import { resolveKokoroEngineConfig } from "../src/services/voice/kokoro/kokoro-engine-discovery";
import type { Phrase } from "../src/services/voice/types";

function skip(msg: string): never {
	console.log(`[kokoro-real-smoke] SKIP: ${msg}`);
	process.exit(2);
}
function fail(msg: string): never {
	console.error(`[kokoro-real-smoke] FAIL: ${msg}`);
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

const ffi = loadElizaInferenceFfi(libPath);
if (typeof ffi.kokoroSupported !== "function" || !ffi.kokoroSupported()) {
	skip(
		`fused lib (ABI v${ffi.libraryAbiVersion}) does not link the in-process Kokoro engine — ` +
			"rebuild with `bun run build:fused-desktop` (LLAMA_BUILD_KOKORO=ON)",
	);
}

const kokoro = resolveKokoroEngineConfig();
if (!kokoro) {
	skip(
		"no Kokoro model staged (set ELIZA_KOKORO_MODEL_DIR to a dir with " +
			"kokoro-82m-v1_0*.gguf + voices/<voice>.bin)",
	);
}

console.log(`[kokoro-real-smoke] lib=${libPath} (ABI v${ffi.libraryAbiVersion})`);
console.log(
	`[kokoro-real-smoke] model=${kokoro.layout.modelFile} voice=${kokoro.defaultVoiceId}`,
);

const backend = createKokoroTtsBackend(kokoro, { ffi });
const preset = createKokoroSpeakerPreset(kokoro);
const phrase: Phrase = {
	id: 1,
	text: "Hello, this is a native Kokoro voice test.",
	fromIndex: 0,
	toIndex: 42,
	terminator: "punctuation",
};

try {
	const start = performance.now();
	let firstAudibleMs: number | null = null;
	let totalSamples = 0;
	let sampleRate = 0;
	await backend.synthesizeStream({
		phrase,
		preset,
		cancelSignal: { cancelled: false },
		onChunk: (c) => {
			if (!c.isFinal && c.pcm.length > 0) {
				if (firstAudibleMs === null) firstAudibleMs = performance.now() - start;
				totalSamples += c.pcm.length;
				sampleRate = c.sampleRate;
			}
			return undefined;
		},
	});
	const ttfa = firstAudibleMs === null ? Number.NaN : Math.round(firstAudibleMs);
	console.log(
		`[kokoro-real-smoke] synthesized ${totalSamples} samples @ ${sampleRate}Hz ` +
			`(${(totalSamples / (sampleRate || 1)).toFixed(2)}s), TTFA=${ttfa}ms`,
	);

	if (totalSamples === 0) fail("empty PCM — Kokoro produced no audio");
	if (sampleRate !== 24_000) fail(`expected 24 kHz PCM, got ${sampleRate}`);
	if (firstAudibleMs === null) fail("no audible chunk was emitted");
	if (firstAudibleMs > KOKORO_MOBILE_TTFA_BUDGET_MS) {
		fail(
			`TTFA ${ttfa}ms exceeds the mobile budget ${KOKORO_MOBILE_TTFA_BUDGET_MS}ms`,
		);
	}
	console.log("[kokoro-real-smoke] PASS");
} finally {
	backend.dispose();
	(ffi as unknown as { close?: () => void }).close?.();
}
