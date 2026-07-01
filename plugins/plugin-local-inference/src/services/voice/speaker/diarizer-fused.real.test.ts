/**
 * Real-FFI tests for `FusedDiarizer`: run against the ACTUAL fused
 * `libelizainference` — loaded, `create`d, and probed for `diarizSupported()`
 * — never a stub. The pyannote diarizer is the SOLE on-device diarization
 * runtime (the `eliza_inference_diariz_*` ABI off the one fused handle), feeding
 * its per-frame powerset labels through the shared pure `classifyFramesToSegments`
 * reducer.
 *
 * Skipped (not faked) when the fused lib is not resolvable, or when it does not
 * link the pyannote diarizer graph. To run them, point `ELIZA_INFERENCE_LIBRARY`
 * (or `ELIZA_INFERENCE_LIB_DIR`) at a built `libelizainference` with the diarizer
 * ABI, or build one via `packages/app-core/scripts/build-llama-cpp-mtp.mjs`.
 * Runs in the post-merge `bun test` lane (`*.real.test.ts` is excluded from the
 * default lane in `vitest.config.ts`).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import { resolveFusedLibraryPath } from "../../desktop-fused-ffi-backend-runtime";
import {
	type ElizaInferenceContextHandle,
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "../ffi-bindings";
import { FusedDiarizer } from "./diarizer-fused";

const DIARIZ_WINDOW_SAMPLES = 16_000 * 5; // 5 s @ 16 kHz

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const LIB_PATH = resolveFusedLibraryPath(null, process.env);
// The native diariz_open needs a pyannote-segmentation GGUF. Provide one via
// ELIZA_TEST_DIARIZ_GGUF; the diarize assertion skips honestly when it isn't
// supplied — it is never faked.
const DIARIZ_GGUF = process.env.ELIZA_TEST_DIARIZ_GGUF?.trim();
const HAVE_MODEL = !!DIARIZ_GGUF && existsSync(DIARIZ_GGUF);

describe.skipIf(!isBun || !LIB_PATH)("FusedDiarizer — real FFI", () => {
	let ffi: ElizaInferenceFfi;
	let ctx: ElizaInferenceContextHandle;
	let tmp: string;

	beforeAll(() => {
		// LIB_PATH is non-null inside the skipIf-guarded block.
		ffi = loadElizaInferenceFfi(LIB_PATH as string);
	});
	afterAll(() => {
		ffi?.close();
	});
	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), "diarizer-fused-real-"));
		ctx = ffi.create(tmp);
	});
	afterEach(() => {
		ffi.destroy(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("isSupported() reflects the loaded build's diarizer ABI", () => {
		expect(typeof FusedDiarizer.isSupported(ffi)).toBe("boolean");
	});

	it.skipIf(!HAVE_MODEL)(
		"diarizeWindow() reduces real native labels into bounded segments",
		async () => {
			const dia = await FusedDiarizer.load({ ffi, ctx, ggufPath: DIARIZ_GGUF });
			expect(dia.sampleRate).toBe(16_000);
			expect(dia.modelId).toBe("pyannote-segmentation-3.0-int8");
			// 5 s of a 180 Hz tone — a real, finite window the native graph accepts.
			const pcm = new Float32Array(DIARIZ_WINDOW_SAMPLES);
			for (let i = 0; i < pcm.length; i += 1) {
				pcm[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16_000);
			}
			const out = await dia.diarizeWindow(pcm);
			// Every reduced segment must be well-formed: start < end, a valid local
			// speaker id, and a confidence in [0, 1]. The exact speaker count is
			// content-dependent and not asserted here.
			expect(out.localSpeakerCount).toBe(
				new Set(out.segments.map((s) => s.localSpeakerId)).size,
			);
			for (const seg of out.segments) {
				expect(seg.endMs).toBeGreaterThanOrEqual(seg.startMs);
				expect(seg.localSpeakerId).toBeGreaterThanOrEqual(0);
				expect(seg.confidence).toBeGreaterThanOrEqual(0);
				expect(seg.confidence).toBeLessThanOrEqual(1);
			}
			await dia.dispose();
		},
	);
});
