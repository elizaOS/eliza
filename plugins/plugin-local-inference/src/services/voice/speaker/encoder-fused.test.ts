/**
 * Fused speaker-encoder tests — `FusedSpeakerEncoder`.
 *
 * The encoder routes through the fused `eliza_inference_speaker_*` FFI surface
 * (ABI v6) off the SAME `libelizainference` handle as VAD / wake-word / TTS /
 * ASR — no standalone `libvoice_classifier`. These tests inject a mock
 * `ElizaInferenceFfi` (no native build) and assert:
 *   - support gating + structured error when the build lacks the speaker ABI,
 *   - the marshalling round-trip: `speakerEmbed` writes a known 256-float
 *     buffer → `encode()` returns it,
 *   - input validation (length floor) before the FFI is hit,
 *   - dispose drives `speakerClose`.
 *
 * The real on-device forward pass is validated in Phase 3 (device) — this
 * suite did not build the native lib.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeSpeakerHandle,
} from "../ffi-bindings";
import { FusedSpeakerEncoder } from "./encoder-fused";
import { SpeakerEncoderGgmlUnavailableError } from "./encoder-ggml";

const EMB_DIM = 256;
const MIN_SAMPLES = 16_000;

/** A deterministic 256-float embedding the mock `speakerEmbed` returns. */
function knownEmbedding(): Float32Array {
	const out = new Float32Array(EMB_DIM);
	for (let i = 0; i < EMB_DIM; i += 1) out[i] = (i + 1) / EMB_DIM;
	return out;
}

/**
 * Build a minimal `ElizaInferenceFfi` stand-in that exercises the speaker
 * path. `supported` flips the capability probe; the other methods are spies so
 * the test can assert call shape.
 */
function makeMockFfi(
	supported: boolean,
	embedding: Float32Array = knownEmbedding(),
): ElizaInferenceFfi {
	const handle: NativeSpeakerHandle = 0xabad1dean;
	const open = vi.fn(() => handle);
	const embed = vi.fn(() => embedding.slice());
	const close = vi.fn(() => undefined);
	const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
	return {
		libraryPath: "/dev/null",
		libraryAbiVersion: "6",
		create: () => ctx,
		destroy: () => {},
		mmapAcquire: () => {},
		mmapEvict: () => {},
		ttsSynthesize: () => 0,
		asrTranscribe: () => "",
		ttsStreamSupported: () => false,
		ttsSynthesizeStream: () => ({ cancelled: false }),
		cancelTts: () => {},
		setVerifierCallback: () => ({ close() {} }),
		asrStreamSupported: () => false,
		asrStreamOpen: () => 0n,
		asrStreamFeed: () => {},
		asrStreamPartial: () => ({ partial: "" }),
		asrStreamFinish: () => ({ partial: "" }),
		asrStreamClose: () => {},
		speakerSupported: () => supported,
		speakerOpen: supported ? open : undefined,
		speakerEmbed: supported ? embed : undefined,
		speakerClose: supported ? close : undefined,
		close: () => {},
	};
}

describe("FusedSpeakerEncoder", () => {
	it("isSupported() reflects the FFI capability probe", () => {
		expect(FusedSpeakerEncoder.isSupported(null)).toBe(false);
		expect(FusedSpeakerEncoder.isSupported(makeMockFfi(false))).toBe(false);
		expect(FusedSpeakerEncoder.isSupported(makeMockFfi(true))).toBe(true);
	});

	it("throws native-missing when the FFI does not export the speaker ABI", async () => {
		const ffi = makeMockFfi(false);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		await expect(FusedSpeakerEncoder.load({ ffi, ctx })).rejects.toMatchObject({
			name: "SpeakerEncoderGgmlUnavailableError",
			code: "native-missing",
		});
	});

	it("exposes the canonical dims + model id", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const enc = await FusedSpeakerEncoder.load({ ffi, ctx });
		expect(enc.embeddingDim).toBe(EMB_DIM);
		expect(enc.sampleRate).toBe(MIN_SAMPLES);
		expect(enc.modelId).toBe("wespeaker-resnet34-lm-int8");
		expect(ffi.speakerOpen).toHaveBeenCalledTimes(1);
		expect(ffi.speakerOpen).toHaveBeenCalledWith({
			ctx,
			ggufPath: null,
		});
	});

	it("encode() round-trips the native 256-float buffer", async () => {
		const expected = knownEmbedding();
		const ffi = makeMockFfi(true, expected);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const enc = await FusedSpeakerEncoder.load({ ffi, ctx });
		const out = await enc.encode(new Float32Array(MIN_SAMPLES));
		expect(out.length).toBe(EMB_DIM);
		expect(Array.from(out)).toEqual(Array.from(expected));
		expect(ffi.speakerEmbed).toHaveBeenCalledTimes(1);
		expect(ffi.speakerEmbed).toHaveBeenCalledWith({
			speaker: 0xabad1dean,
			pcm: expect.any(Float32Array),
		});
	});

	it("threads an explicit ggufPath through speakerOpen", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		await FusedSpeakerEncoder.load({
			ffi,
			ctx,
			ggufPath: "/abs/wespeaker.gguf",
		});
		expect(ffi.speakerOpen).toHaveBeenCalledWith({
			ctx,
			ggufPath: "/abs/wespeaker.gguf",
		});
	});

	it("resolves the ctx accessor when given a thunk", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0x1234n;
		const ctxThunk = vi.fn(() => ctx);
		await FusedSpeakerEncoder.load({ ffi, ctx: ctxThunk });
		expect(ctxThunk).toHaveBeenCalledTimes(1);
		expect(ffi.speakerOpen).toHaveBeenCalledWith({ ctx, ggufPath: null });
	});

	it("rejects pcm shorter than the minimum window before hitting the FFI", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const enc = await FusedSpeakerEncoder.load({ ffi, ctx });
		await expect(enc.encode(new Float32Array(100))).rejects.toMatchObject({
			name: "SpeakerEncoderGgmlUnavailableError",
			code: "invalid-input",
		});
		expect(ffi.speakerEmbed).not.toHaveBeenCalled();
	});

	it("dispose() drives speakerClose once and is idempotent", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const enc = await FusedSpeakerEncoder.load({ ffi, ctx });
		await enc.dispose();
		expect(ffi.speakerClose).toHaveBeenCalledTimes(1);
		await enc.dispose();
		expect(ffi.speakerClose).toHaveBeenCalledTimes(1);
		await expect(
			enc.encode(new Float32Array(MIN_SAMPLES)),
		).rejects.toMatchObject({ name: "SpeakerEncoderGgmlUnavailableError" });
	});
});

// Suppress unused-import lints when the error class isn't referenced directly.
void SpeakerEncoderGgmlUnavailableError;
