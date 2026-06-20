/**
 * Unit tests for the whisper.cpp ASR tier in `createStreamingTranscriber`.
 *
 * The whisper.cpp runtime resolver and decoder factory are injected through
 * the `resolveWhisperCppRuntime` / `makeWhisperCppDecoder` option seam (the
 * same dependency-injection pattern the fused-FFI path uses via `ffi` /
 * `getContext`), so the chain-resolution logic is exercised without
 * dlopen()'ing libwhisper_eliza_adapter or loading a real ggml-*.bin model —
 * and it works identically under Vitest and Bun's test runner (no reliance on
 * module-mock interception). End-to-end live transcription is covered by the
 * post-merge live test (gated on `TEST_LANE=post-merge`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AsrUnavailableError,
	type CreateStreamingTranscriberOptions,
	createStreamingTranscriber,
	WhisperCppStreamingTranscriber,
} from "./transcriber";
import type { WhisperCppRuntime } from "./whisper-cpp-asr";

// Shared mock state, recorded by the injected decoder factory.
const mockState = {
	runtimeFixture: null as WhisperCppRuntime | null,
	decoderCalls: [] as Array<Float32Array>,
	decoderResponse: "whisper-mock-transcript",
	disposeCalls: { count: 0 },
};

const FIXTURE_RUNTIME: WhisperCppRuntime = {
	libraryPath: "/fake/libwhisper_eliza_adapter.so",
	modelPath: "/fake/ggml-base.en.bin",
	language: "en",
	translate: false,
	nThreads: 4,
	useGpu: true,
};

/**
 * Inject the whisper.cpp seam (resolver + decoder factory) into every call so
 * the chain resolves the mocked runtime instead of probing disk.
 */
function whisperSeam(
	extra: CreateStreamingTranscriberOptions = {},
): CreateStreamingTranscriberOptions {
	return {
		resolveWhisperCppRuntime: () => mockState.runtimeFixture,
		makeWhisperCppDecoder: () => ({
			decoder: async (pcm16k: Float32Array): Promise<string> => {
				mockState.decoderCalls.push(pcm16k);
				return mockState.decoderResponse;
			},
			dispose: () => {
				mockState.disposeCalls.count++;
			},
		}),
		...extra,
	};
}

beforeEach(() => {
	mockState.decoderCalls.length = 0;
	mockState.disposeCalls.count = 0;
	mockState.runtimeFixture = null;
	mockState.decoderResponse = "whisper-mock-transcript";
});

afterEach(() => {
	mockState.runtimeFixture = null;
	delete process.env.ELIZA_LOCAL_ASR_BACKEND;
	delete process.env.ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP;
});

describe("createStreamingTranscriber — whisper.cpp tier", () => {
	it("returns whisper.cpp-backed transcriber when artifacts are on disk (auto chain)", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber(whisperSeam());
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("prefer:'whisper-cpp' throws when no runtime is resolvable", () => {
		mockState.runtimeFixture = null;
		expect(() =>
			createStreamingTranscriber(whisperSeam({ prefer: "whisper-cpp" })),
		).toThrow(AsrUnavailableError);
	});

	it("prefer:'whisper-cpp' returns the whisper.cpp tier when artifacts present", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber(
			whisperSeam({ prefer: "whisper-cpp" }),
		);
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("uses ELIZA_LOCAL_ASR_BACKEND=whisper-cpp as an explicit backend preference", () => {
		process.env.ELIZA_LOCAL_ASR_BACKEND = "whisper-cpp";
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber(whisperSeam());
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
	});

	it("ELIZA_LOCAL_ASR_BACKEND=whisper selects the whisper.cpp tier directly", () => {
		process.env.ELIZA_LOCAL_ASR_BACKEND = "whisper";
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber(whisperSeam());
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
	});

	it("auto chain uses whisper.cpp when artifacts are present and no fused build is available", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber(whisperSeam());
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("auto chain skips whisper.cpp when ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP=false", () => {
		process.env.ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP = "false";
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		expect(() => createStreamingTranscriber(whisperSeam())).toThrow(
			AsrUnavailableError,
		);
		expect(mockState.disposeCalls.count).toBe(0);
	});

	it("auto chain skips whisper.cpp when allowWhisperCpp=false", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		expect(() =>
			createStreamingTranscriber(whisperSeam({ allowWhisperCpp: false })),
		).toThrow(AsrUnavailableError);
		expect(mockState.disposeCalls.count).toBe(0);
	});

	it("forwards PCM windows from the transcriber to the underlying decoder", async () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		mockState.decoderResponse = "hello world";
		const t = createStreamingTranscriber(
			whisperSeam({ prefer: "whisper-cpp" }),
		);
		// drive a tiny PCM window through the sliding-window harness so the
		// decoder mock observes at least one call.
		const pcm = new Float32Array(16000); // 1s of silence
		t.feed({ pcm, sampleRate: 16000, timestampMs: 0 });
		const result = await t.flush();
		expect(result.partial).toContain("hello");
		expect(mockState.decoderCalls.length).toBeGreaterThan(0);
		t.dispose();
	});
});
