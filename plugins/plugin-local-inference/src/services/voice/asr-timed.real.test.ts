/**
 * Real-FFI test for fused ASR v12 per-word timings on REAL audio.
 *
 * Runs the ACTUAL fused `libelizainference` (`eliza_inference_asr_transcribe_timed`,
 * ABI v12) end-to-end on a real speech recording (`native/omnivoice.cpp/
 * examples/freeman.wav`) — decode → ASR → per-word `[startMs,endMs)` — and
 * asserts the transcript is non-empty and the word timings satisfy the playback
 * contract (`validateAsrWordTimings`) against the exact decoded audio duration.
 *
 * This is the single-pipe word-timing feature validated against real known
 * audio, not a stub. Skipped (never faked) when:
 *   - not running under Bun (`bun:ffi`),
 *   - the fused lib is not resolvable (`ELIZA_INFERENCE_LIBRARY` /
 *     `ELIZA_INFERENCE_LIB_DIR`, or a build under build-static-fused),
 *   - no Eliza-1 ASR bundle is provided (`ELIZA_ASR_BUNDLE`, or the default
 *     `~/.eliza/local-inference/models/eliza-1-0_8b.bundle`),
 *   - the `freeman.wav` speech submodule isn't checked out,
 *   - or the loaded build predates v12 (`timedAsrSupported() === false`).
 * Runs in the post-merge lane (`*.real.test.ts` is excluded from the default
 * `vitest.config.ts` lane).
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAsrWordTimings } from "@elizaos/shared/transcripts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveFusedLibraryPath } from "../desktop-fused-ffi-backend-runtime";
import { decodeMonoPcm16Wav } from "./engine-bridge";
import {
	type ElizaInferenceContextHandle,
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "./ffi-bindings";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const LIB_PATH =
	resolveFusedLibraryPath(null, process.env) ??
	(() => {
		const built = fileURLToPath(
			new URL(
				"../../../native/llama.cpp/build-static-fused/bin/libelizainference.so",
				import.meta.url,
			),
		);
		return existsSync(built) ? built : null;
	})();

const BUNDLE =
	process.env.ELIZA_ASR_BUNDLE?.trim() ||
	path.join(os.homedir(), ".eliza/local-inference/models/eliza-1-0_8b.bundle");
const HAVE_BUNDLE = existsSync(BUNDLE);

const FREEMAN_WAV = fileURLToPath(
	new URL(
		"../../../native/omnivoice.cpp/examples/freeman.wav",
		import.meta.url,
	),
);
const HAVE_FREEMAN = existsSync(FREEMAN_WAV);

describe.skipIf(!isBun || !LIB_PATH || !HAVE_BUNDLE)(
	"fused ASR v12 per-word timings — real FFI on real audio",
	() => {
		let ffi: ElizaInferenceFfi;
		let ctx: ElizaInferenceContextHandle;

		beforeAll(() => {
			ffi = loadElizaInferenceFfi(LIB_PATH as string);
			ctx = ffi.create(BUNDLE);
			ffi.mmapAcquire(ctx, "asr");
		});
		afterAll(() => {
			if (ffi && ctx) {
				ffi.mmapEvict(ctx, "asr");
				ffi.destroy(ctx);
			}
			ffi?.close();
		});

		it("loads a v12 build that advertises timed ASR", () => {
			expect(ffi.libraryAbiVersion).toBe("12");
			expect(ffi.timedAsrSupported()).toBe(true);
		});

		it.skipIf(!HAVE_FREEMAN)(
			"transcribes freeman.wav with well-formed per-word timings",
			() => {
				const { pcm, sampleRate } = decodeMonoPcm16Wav(
					new Uint8Array(readFileSync(FREEMAN_WAV)),
				);
				const audioDurationMs = (pcm.length / sampleRate) * 1000;

				const { text, words } = ffi.asrTranscribeTimed({
					ctx,
					pcm,
					sampleRateHz: sampleRate,
				});

				// Real speech → a non-empty transcript with at least a few words.
				expect(text.trim().length).toBeGreaterThan(0);
				expect(words.length).toBeGreaterThan(2);

				// Every emitted span is ordered, non-overlapping, and inside the
				// real audio duration — the contract the player highlights against.
				const validation = validateAsrWordTimings(words, audioDurationMs);
				expect(validation.violations).toEqual([]);
				expect(validation.ok).toBe(true);

				// The final word ends at (≈) the true end of the audio.
				const last = words[words.length - 1];
				expect(last).toBeDefined();
				expect((last as { endMs: number }).endMs).toBeLessThanOrEqual(
					audioDurationMs + 1,
				);
				expect((last as { endMs: number }).endMs).toBeGreaterThan(
					audioDurationMs * 0.5,
				);
			},
		);
	},
);
