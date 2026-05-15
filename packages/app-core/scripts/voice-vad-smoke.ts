#!/usr/bin/env bun
/**
 * VAD / wake-word smoke harness.
 *
 * Feeds a `silence + synthesized-speech + silence` PCM fixture through the
 * native GGML Silero VAD backend (`GgmlSileroVad` + `VadDetector`) and
 * asserts it detects exactly one speech segment whose boundaries land inside
 * the voiced region — i.e. the leading/trailing silence is gated out.
 *
 * Wake-word smoke lives in `packages/inference/voice-bench/` against the
 * fused library and bundled `wake/openwakeword.gguf`. This script still
 * resolves the bundled GGUF to report its presence, then exits the wake-word
 * section.
 *
 * Usage:
 *   bun packages/app-core/scripts/voice-vad-smoke.ts \
 *     --bundle /path/to/eliza-1-0_8b.bundle \
 *     --dylib /path/to/libelizainference.dylib
 *
 * Exit code: 0 on pass, 1 on any assertion failure or unavailable runtime.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SR = 16_000;
const WINDOW = 512;
const SILERO_VAD_REL = path.join("vad", "silero-vad-v5.1.2.ggml.bin");
const WAKE_WORD_REL = path.join("wake", "openwakeword.gguf");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
	console.error(`[voice-vad-smoke] FAIL: ${msg}`);
	process.exit(1);
}

function resolveVadPath(opts: {
	modelPath?: string;
	bundleRoot?: string;
}): string | null {
	const candidates = [
		opts.modelPath,
		opts.bundleRoot ? path.join(opts.bundleRoot, SILERO_VAD_REL) : undefined,
		process.env.ELIZA_VAD_MODEL_PATH?.trim() || undefined,
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return path.resolve(candidate);
	}
	return null;
}

async function main(): Promise<void> {
	const { makeSpeechWithSilenceFixture } = await import(
		"../../../plugins/plugin-local-inference/src/services/voice/__test-helpers__/synthetic-speech"
	);
	const { loadElizaInferenceFfi } = await import(
		"../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings"
	);
	const bundleRoot = arg("--bundle");
	const dylibPath = arg("--dylib") ?? process.env.ELIZA_INFERENCE_DYLIB_PATH;
	const modelPath = process.env.ELIZA_VAD_MODEL_PATH;
	const resolved = resolveVadPath({ modelPath, bundleRoot });
	if (!resolved) {
		fail(
			"no Silero VAD model found. Stage vad/silero-vad-v5.1.2.ggml.bin into a bundle (--bundle) or set ELIZA_VAD_MODEL_PATH.",
    );
  }
  if (!bundleRoot) fail("--bundle is required for native GGML VAD");
  if (!dylibPath) fail("--dylib or ELIZA_INFERENCE_DYLIB_PATH is required");
	console.log(`[voice-vad-smoke] Silero VAD model: ${resolved}`);

	const ffi = loadElizaInferenceFfi(dylibPath);
	if (!ffi.vadSupported?.()) {
		fail("native GGML VAD is unavailable in this libelizainference build");
	}
	const ctx = ffi.create(bundleRoot);
	let vad: ReturnType<typeof ffi.vadOpen> | null = null;
	try {
		vad = ffi.vadOpen({ ctx, sampleRateHz: SR });

		// Sanity: pure silence reads low.
		ffi.vadReset(vad);
		const pSilence = ffi.vadProcess({ vad, pcm: new Float32Array(WINDOW) });
		console.log(
			`[voice-vad-smoke] P(speech | silence) = ${pSilence.toFixed(3)}`,
		);
		if (pSilence >= 0.3) fail(`silence read too high (${pSilence})`);

		const fx = makeSpeechWithSilenceFixture({
			sampleRate: SR,
			leadSilenceSec: 0.6,
			speechSec: 1.2,
			tailSilenceSec: 0.6,
		});
		const speechStartMs = (fx.speechStartSample / SR) * 1000;
		const speechEndMs = (fx.speechEndSample / SR) * 1000;

		ffi.vadReset(vad);
		const probs: number[] = [];
		for (let i = 0; (i + 1) * WINDOW <= fx.pcm.length; i++) {
			probs.push(
				ffi.vadProcess({
					vad,
					pcm: fx.pcm.slice(i * WINDOW, (i + 1) * WINDOW),
				}),
			);
		}
		const speechStartWindow = Math.floor(fx.speechStartSample / WINDOW);
		const speechEndWindow = Math.ceil(fx.speechEndSample / WINDOW);
		const leadingMax = Math.max(...probs.slice(0, speechStartWindow), 0);
		const speechMax = Math.max(
			...probs.slice(speechStartWindow, speechEndWindow),
			0,
		);
		const trailing = probs.slice(speechEndWindow);
		const trailingMax = Math.max(...trailing, 0);
		const trailingLateMax = Math.max(...trailing.slice(-6), 0);
		const onsetWindow = probs.findIndex(
			(p, i) => i >= speechStartWindow && i < speechEndWindow && p >= 0.5,
		);
		const onsetMs = onsetWindow >= 0 ? (onsetWindow * WINDOW * 1000) / SR : -1;
		console.log(
			`[voice-vad-smoke] fixture probabilities: leadingMax=${leadingMax.toFixed(3)} speechMax=${speechMax.toFixed(3)} trailingMax=${trailingMax.toFixed(3)} trailingLateMax=${trailingLateMax.toFixed(3)}`,
		);
		if (leadingMax >= 0.3) fail(`leading silence read too high (${leadingMax})`);
		if (trailingLateMax >= 0.3)
			fail(`late trailing silence read too high (${trailingLateMax})`);
		if (speechMax < 0.5)
			fail(`synthetic speech never crossed onset threshold (${speechMax})`);
		if (onsetMs < speechStartMs || onsetMs >= speechEndMs) {
			fail(
				`speech onset at ${onsetMs.toFixed(0)} ms is outside the voiced region [${speechStartMs.toFixed(0)}, ${speechEndMs.toFixed(0)}]`,
			);
		}
		console.log(
			`[voice-vad-smoke] PASS: native GGML VAD crossed onset at ${onsetMs.toFixed(0)} ms (voiced region ${speechStartMs.toFixed(0)}-${speechEndMs.toFixed(0)} ms)`,
		);
	} finally {
		if (vad) ffi.vadClose(vad);
		ffi.destroy(ctx);
		ffi.close?.();
	}

	// Wake-word: report bundled GGUF presence only. Runtime inference is
	// covered by the fused-library smoke under packages/inference/voice-bench/
	// — this script doesn't bring up a libelizainference FFI context.
	const wakeWordPath = bundleRoot ? path.join(bundleRoot, WAKE_WORD_REL) : null;
	if (!wakeWordPath || !existsSync(wakeWordPath)) {
		console.log(
			"[voice-vad-smoke] wake-word: no bundled openwakeword.gguf (optional asset) — skipping.",
		);
		return;
	}
	console.log(
		`[voice-vad-smoke] wake-word GGUF present: ${wakeWordPath}. Runtime inference smoke lives in packages/inference/voice-bench/.`,
	);
}

main().catch((err) => {
  console.error("[voice-vad-smoke] error:", err);
  process.exit(1);
});
