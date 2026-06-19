/**
 * Fused diarizer tests — `FusedDiarizer`.
 *
 * The diarizer routes through the fused `eliza_inference_diariz_*` FFI surface
 * (ABI v6) off the SAME `libelizainference` handle as VAD / speaker / TTS /
 * ASR — no standalone `libvoice_classifier`. These tests inject a mock
 * `ElizaInferenceFfi` (no native build) and assert:
 *   - support gating + structured error when the build lacks the diarizer ABI,
 *   - the marshalling: `diarizSegment` returns a known int8 label sequence →
 *     `diarizeWindow()` one-hots + reduces it through the shared pure
 *     `classifyFramesToSegments` into speaker segments,
 *   - an out-of-range powerset label is a hard error (no fabricated output),
 *   - dispose drives `diarizClose`.
 *
 * The real on-device forward pass is validated in Phase 3 (device) — this
 * suite did not build the native lib.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeDiarizHandle,
} from "../ffi-bindings";
import { DiarizerUnavailableError, PYANNOTE_FRAME_STRIDE_MS } from "./diarizer";
import { FusedDiarizer } from "./diarizer-fused";

/**
 * Build a minimal `ElizaInferenceFfi` stand-in that exercises the diarizer
 * path. `supported` flips the capability probe; `labels` is the int8 frame
 * sequence the mock `diarizSegment` returns.
 */
function makeMockFfi(
	supported: boolean,
	labels: Int8Array = new Int8Array(293),
): ElizaInferenceFfi {
	const handle: NativeDiarizHandle = 0xfeedfacen;
	const open = vi.fn(() => handle);
	const segment = vi.fn(() => labels.slice());
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
		diarizSupported: () => supported,
		diarizOpen: supported ? open : undefined,
		diarizSegment: supported ? segment : undefined,
		diarizClose: supported ? close : undefined,
		close: () => {},
	};
}

describe("FusedDiarizer", () => {
	it("isSupported() reflects the FFI capability probe", () => {
		expect(FusedDiarizer.isSupported(null)).toBe(false);
		expect(FusedDiarizer.isSupported(makeMockFfi(false))).toBe(false);
		expect(FusedDiarizer.isSupported(makeMockFfi(true))).toBe(true);
	});

	it("throws native-missing when the FFI does not export the diarizer ABI", async () => {
		const ffi = makeMockFfi(false);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		await expect(FusedDiarizer.load({ ffi, ctx })).rejects.toMatchObject({
			name: "DiarizerUnavailableError",
			code: "native-missing",
		});
	});

	it("opens with NULL gguf path by default + carries the model id", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const dia = await FusedDiarizer.load({ ffi, ctx });
		expect(dia.sampleRate).toBe(16_000);
		expect(dia.modelId).toBe("pyannote-segmentation-3.0-int8");
		expect(ffi.diarizOpen).toHaveBeenCalledWith({ ctx, ggufPath: null });
	});

	it("reduces a single-speaker label run into one segment", async () => {
		// 100 frames of class 1 (speaker 0 only). One contiguous run → 1 segment.
		const labels = new Int8Array(100).fill(1);
		const ffi = makeMockFfi(true, labels);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const dia = await FusedDiarizer.load({ ffi, ctx });
		const out = await dia.diarizeWindow(new Float32Array(80_000));
		expect(out.localSpeakerCount).toBe(1);
		expect(out.segments).toHaveLength(1);
		expect(out.segments[0].localSpeakerId).toBe(0);
		expect(out.segments[0].hasOverlap).toBe(false);
		expect(out.segments[0].startMs).toBe(0);
		expect(out.segments[0].endMs).toBe(
			Math.round(100 * PYANNOTE_FRAME_STRIDE_MS),
		);
		expect(out.speechMs).toBe(Math.round(100 * PYANNOTE_FRAME_STRIDE_MS));
		expect(ffi.diarizSegment).toHaveBeenCalledTimes(1);
	});

	it("splits two speakers + flags an overlap class", async () => {
		// frames 0-19: speaker 0 (class 1); 20-39: speakers 0+1 overlap (class 4);
		// 40-59: speaker 1 (class 2). Reduces to runs for speaker 0 (0-39) and
		// speaker 1 (20-59), with the overlap region flagged.
		const labels = new Int8Array(60);
		for (let i = 0; i < 20; i += 1) labels[i] = 1;
		for (let i = 20; i < 40; i += 1) labels[i] = 4;
		for (let i = 40; i < 60; i += 1) labels[i] = 2;
		const ffi = makeMockFfi(true, labels);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const dia = await FusedDiarizer.load({ ffi, ctx });
		const out = await dia.diarizeWindow(new Float32Array(80_000));
		expect(out.localSpeakerCount).toBe(2);
		const speakerIds = new Set(out.segments.map((s) => s.localSpeakerId));
		expect(speakerIds).toEqual(new Set([0, 1]));
		expect(out.segments.some((s) => s.hasOverlap)).toBe(true);
	});

	it("silence-only labels yield no segments", async () => {
		const labels = new Int8Array(50).fill(0); // class 0 = silence
		const ffi = makeMockFfi(true, labels);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const dia = await FusedDiarizer.load({ ffi, ctx });
		const out = await dia.diarizeWindow(new Float32Array(80_000));
		expect(out.segments).toHaveLength(0);
		expect(out.localSpeakerCount).toBe(0);
		expect(out.speechMs).toBe(0);
	});

	it("rejects an out-of-range powerset label instead of fabricating output", async () => {
		const labels = new Int8Array([1, 1, 9, 1]); // 9 is out of [0, 7)
		const ffi = makeMockFfi(true, labels);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const dia = await FusedDiarizer.load({ ffi, ctx });
		await expect(
			dia.diarizeWindow(new Float32Array(80_000)),
		).rejects.toMatchObject({
			name: "DiarizerUnavailableError",
			code: "model-load-failed",
		});
	});

	it("dispose() drives diarizClose once and is idempotent", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const dia = await FusedDiarizer.load({ ffi, ctx });
		await dia.dispose();
		expect(ffi.diarizClose).toHaveBeenCalledTimes(1);
		await dia.dispose();
		expect(ffi.diarizClose).toHaveBeenCalledTimes(1);
		await expect(
			dia.diarizeWindow(new Float32Array(80_000)),
		).rejects.toMatchObject({ name: "DiarizerUnavailableError" });
	});
});

// Suppress unused-import lints when the error class isn't referenced directly.
void DiarizerUnavailableError;
