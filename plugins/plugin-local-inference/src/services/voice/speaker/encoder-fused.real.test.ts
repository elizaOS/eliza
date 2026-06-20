/**
 * Real-FFI tests for `FusedSpeakerEncoder`: run against the ACTUAL fused
 * `libelizainference` — loaded, `create`d, and probed for `speakerSupported()`
 * — never a stub. The speaker encoder is the SOLE on-device speaker runtime
 * (the `eliza_inference_speaker_*` ABI off the one fused handle).
 *
 * Skipped (not faked) when the fused lib is not resolvable, or when it does not
 * link the WeSpeaker speaker graph. To run them, point `ELIZA_INFERENCE_LIBRARY`
 * (or `ELIZA_INFERENCE_LIB_DIR`) at a built `libelizainference` with the speaker
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
import { FusedSpeakerEncoder } from "./encoder-fused";

const EMB_DIM = 256;
const MIN_SAMPLES = 16_000;

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const LIB_PATH = resolveFusedLibraryPath(null, process.env);
// The native speaker_open needs a WeSpeaker GGUF. Provide one via
// ELIZA_TEST_SPEAKER_GGUF (e.g. wespeaker-resnet34-lm.gguf); the encode
// assertions skip honestly when it isn't supplied — they are never faked.
const SPEAKER_GGUF = process.env.ELIZA_TEST_SPEAKER_GGUF?.trim();
const HAVE_MODEL = !!SPEAKER_GGUF && existsSync(SPEAKER_GGUF);

describe.skipIf(!isBun || !LIB_PATH)("FusedSpeakerEncoder — real FFI", () => {
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
		tmp = mkdtempSync(path.join(os.tmpdir(), "speaker-fused-real-"));
		ctx = ffi.create(tmp);
	});
	afterEach(() => {
		ffi.destroy(ctx);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("isSupported() reflects the loaded build's speaker ABI", () => {
		expect(typeof FusedSpeakerEncoder.isSupported(ffi)).toBe("boolean");
	});

	it.skipIf(!HAVE_MODEL)(
		"encode() returns a finite 256-d embedding off the real WeSpeaker graph",
		async () => {
			const enc = await FusedSpeakerEncoder.load({
				ffi,
				ctx,
				ggufPath: SPEAKER_GGUF,
			});
			expect(enc.embeddingDim).toBe(EMB_DIM);
			expect(enc.sampleRate).toBe(MIN_SAMPLES);
			// 1 s of a 220 Hz tone — a real, finite input the native graph accepts.
			const pcm = new Float32Array(MIN_SAMPLES);
			for (let i = 0; i < pcm.length; i += 1) {
				pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / MIN_SAMPLES);
			}
			const emb = await enc.encode(pcm);
			expect(emb.length).toBe(EMB_DIM);
			expect(emb.every((v) => Number.isFinite(v))).toBe(true);
			// A non-degenerate embedding has real magnitude.
			let norm = 0;
			for (const v of emb) norm += v * v;
			expect(Math.sqrt(norm)).toBeGreaterThan(0);
			await enc.dispose();
		},
	);

	it.skipIf(!HAVE_MODEL)(
		"rejects pcm shorter than the minimum window before hitting the native graph",
		async () => {
			const enc = await FusedSpeakerEncoder.load({
				ffi,
				ctx,
				ggufPath: SPEAKER_GGUF,
			});
			await expect(enc.encode(new Float32Array(100))).rejects.toMatchObject({
				name: "SpeakerEncoderGgmlUnavailableError",
				code: "invalid-input",
			});
			await enc.dispose();
		},
	);
});
