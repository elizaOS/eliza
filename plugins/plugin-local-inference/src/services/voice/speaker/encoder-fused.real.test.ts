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

import { mkdtempSync, rmSync } from "node:fs";
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

describe.skipIf(!isBun || !LIB_PATH)("FusedSpeakerEncoder — real FFI", () => {
	let ffi: ElizaInferenceFfi;
	let ctx: ElizaInferenceContextHandle;
	let tmp: string;
	let speakerSupported = false;

	beforeAll(() => {
		// LIB_PATH is non-null inside the skipIf-guarded block.
		ffi = loadElizaInferenceFfi(LIB_PATH as string);
		speakerSupported = FusedSpeakerEncoder.isSupported(ffi);
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

	it("encode() returns a 256-d unit-norm embedding off the real graph", async () => {
		if (!speakerSupported) {
			throw new Error(
				`[test] the fused lib at ${LIB_PATH} (ABI v${ffi.libraryAbiVersion}) does not link the WeSpeaker speaker graph (eliza_inference_speaker_supported() == 0) — rebuild with the speaker ABI to run this assertion.`,
			);
		}
		const enc = await FusedSpeakerEncoder.load({ ffi, ctx });
		expect(enc.embeddingDim).toBe(EMB_DIM);
		expect(enc.sampleRate).toBe(MIN_SAMPLES);
		// 1 s of a 220 Hz tone — a real, finite input the native graph accepts.
		const pcm = new Float32Array(MIN_SAMPLES);
		for (let i = 0; i < pcm.length; i += 1) {
			pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / MIN_SAMPLES);
		}
		const emb = await enc.encode(pcm);
		expect(emb.length).toBe(EMB_DIM);
		let norm = 0;
		for (const v of emb) norm += v * v;
		expect(Math.abs(Math.sqrt(norm) - 1)).toBeLessThan(0.05);
		await enc.dispose();
	});

	it("rejects pcm shorter than the minimum window before hitting the native graph", async () => {
		if (!speakerSupported) return;
		const enc = await FusedSpeakerEncoder.load({ ffi, ctx });
		await expect(enc.encode(new Float32Array(100))).rejects.toMatchObject({
			name: "SpeakerEncoderGgmlUnavailableError",
			code: "invalid-input",
		});
		await enc.dispose();
	});
});
