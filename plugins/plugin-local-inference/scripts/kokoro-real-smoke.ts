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
 *   KOKORO_SMOKE_REQUIRE — when truthy (1/true/yes), turn every skip (missing
 *     bun runtime / fused lib / model / ABI) into a hard failure (exit 1) instead
 *     of a skip (exit 2), so a CI lane that is supposed to have staged the assets
 *     goes RED when they are absent rather than passing silently (#9588 gate).
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

const kokoroSmokeRequireStaged = (() => {
	const v = process.env.KOKORO_SMOKE_REQUIRE?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes";
})();
function skip(msg: string): never {
	if (kokoroSmokeRequireStaged) {
		console.error(
			`[kokoro-real-smoke] FAIL (KOKORO_SMOKE_REQUIRE set): ${msg}`,
		);
		process.exit(1);
	}
	console.log(`[kokoro-real-smoke] SKIP: ${msg}`);
	process.exit(2);
}
function fail(msg: string): never {
	console.error(`[kokoro-real-smoke] FAIL: ${msg}`);
	process.exit(1);
}

/** Word-level error rate (Levenshtein over normalized word tokens). */
function wordErrorRate(reference: string, hypothesis: string): number {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter(Boolean);
	const r = norm(reference);
	const h = norm(hypothesis);
	if (r.length === 0) return h.length === 0 ? 0 : 1;
	const d: number[][] = Array.from({ length: r.length + 1 }, () =>
		new Array<number>(h.length + 1).fill(0),
	);
	for (let i = 0; i <= r.length; i++) d[i]![0] = i;
	for (let j = 0; j <= h.length; j++) d[0]![j] = j;
	for (let i = 1; i <= r.length; i++) {
		for (let j = 1; j <= h.length; j++) {
			d[i]![j] =
				r[i - 1] === h[j - 1]
					? d[i - 1]![j - 1]!
					: 1 +
						Math.min(d[i - 1]![j - 1]!, d[i - 1]![j]!, d[i]![j - 1]!);
		}
	}
	return d[r.length]![h.length]! / r.length;
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
	const pcmChunks: Float32Array[] = [];
	await backend.synthesizeStream({
		phrase,
		preset,
		cancelSignal: { cancelled: false },
		onChunk: (c) => {
			if (!c.isFinal && c.pcm.length > 0) {
				if (firstAudibleMs === null) firstAudibleMs = performance.now() - start;
				totalSamples += c.pcm.length;
				sampleRate = c.sampleRate;
				pcmChunks.push(c.pcm);
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

	// Speech-vs-noise guard — runs ALWAYS (no ASR bundle needed), catching the
	// class of bug where the model loads + synthesizes prompt PCM but the audio
	// is inaudible NOISE rather than speech. Real speech is strongly amplitude-
	// modulated by syllables (frame-RMS envelope coefficient-of-variation ≫ 0.4);
	// constant noise/tone is flat (cv ≈ 0). This is exactly the signature that
	// distinguished working Kokoro (cv≈1.3) from the #9588 dtype-bug noise
	// (cv≈0.002, where weights shipped quantized/F32 instead of F16). The full
	// pcm is reassembled once here and reused by the ASR gate below.
	const pcmAll = new Float32Array(totalSamples);
	{
		let off = 0;
		for (const ch of pcmChunks) {
			pcmAll.set(ch, off);
			off += ch.length;
		}
	}
	{
		const frame = Math.floor(sampleRate * 0.01); // 10 ms frames
		const env: number[] = [];
		for (let i = 0; i + frame <= pcmAll.length; i += frame) {
			let s = 0;
			for (let j = 0; j < frame; j++) {
				const v = pcmAll[i + j] ?? 0;
				s += v * v;
			}
			env.push(Math.sqrt(s / frame));
		}
		const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
		const variance =
			env.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
			Math.max(1, env.length);
		const cv = mean > 1e-6 ? Math.sqrt(variance) / mean : 0;
		const SPEECH_ENVELOPE_CV_MIN = 0.4;
		console.log(
			`[kokoro-real-smoke] envelope-cv ${cv.toFixed(3)} (speech ≫${SPEECH_ENVELOPE_CV_MIN}, noise ≈0)`,
		);
		if (cv < SPEECH_ENVELOPE_CV_MIN) {
			fail(
				`synthesized audio is inaudible noise, not speech: envelope-cv ${cv.toFixed(3)} < ${SPEECH_ENVELOPE_CV_MIN} ` +
					`(a flat amplitude envelope — the model loaded + produced PCM but it is noise, e.g. weights not F16; see #9588)`,
			);
		}
	}

	// Audio-CORRECTNESS gate (run BEFORE the TTFA perf gate — "is it speech" is a
	// stricter, more important question than "is it fast", and TTFA is slow on
	// desktop CPU even when the audio is perfect). The non-empty/sample-rate
	// checks above pass even on noise/garbage (the exact gap that let a loader
	// regression ship inaudible audio). When an ASR bundle is staged, transcribe
	// the synthesized speech with eligible fused local ASR and gate on WER against the
	// input text, so "it produced audio" can't masquerade as "it produced
	// speech". Without the bundle the gate is skipped with a loud warning (audio
	// remains UNVERIFIED), preserving the lighter dev lane.
	const asrBundle = process.env.ELIZA_ASR_BUNDLE?.trim();
	if (!asrBundle) {
		console.warn(
			"[kokoro-real-smoke] WARN: ELIZA_ASR_BUNDLE not set — audio CORRECTNESS is UNVERIFIED " +
				"(non-empty PCM only). Set it to a dir with asr/eliza-1-asr.gguf + -mmproj.gguf to gate intelligibility (WER).",
		);
	} else {
		const asrCtx = ffi.create(asrBundle);
		let transcript: string;
		try {
			ffi.mmapAcquire(asrCtx, "asr");
			transcript = ffi
				.asrTranscribe({ ctx: asrCtx, pcm: pcmAll, sampleRateHz: sampleRate })
				.trim();
		} finally {
			ffi.mmapEvict(asrCtx, "asr");
			ffi.destroy(asrCtx);
		}
		const wer = wordErrorRate(phrase.text, transcript);
		const WER_BUDGET = 0.5;
		console.log(
			`[kokoro-real-smoke] ASR transcript: "${transcript}" — WER ${wer.toFixed(2)} vs "${phrase.text}"`,
		);
		if (wer > WER_BUDGET) {
			fail(
				`synthesized audio is not intelligible: ASR WER ${wer.toFixed(2)} > ${WER_BUDGET} ` +
					`(transcript "${transcript}" vs reference "${phrase.text}")`,
			);
		}
	}

	// Perf gate last: mobile-class time-to-first-audio budget.
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
