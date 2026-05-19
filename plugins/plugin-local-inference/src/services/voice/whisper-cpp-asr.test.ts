/**
 * Unit tests for the whisper.cpp ASR tier in `createStreamingTranscriber`.
 *
 * Mocks `./whisper-cpp-asr` so the chain logic is exercised without
 * dlopen()'ing libwhisper_eliza_adapter or loading a real ggml-*.bin model.
 * End-to-end live transcription is covered by the post-merge live test
 * (gated on `TEST_LANE=post-merge`).
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Shared mock state. The mock is installed with `doMock` before the dynamic
// import so this works in both Vitest and Bun's test runner.
const mockState = {
	runtimeFixture: null as null | {
		libraryPath: string;
		modelPath: string;
		language: string;
		translate: boolean;
		nThreads: number;
		useGpu: boolean;
	},
	decoderCalls: [] as Array<Float32Array>,
	decoderResponse: "whisper-mock-transcript",
	disposeCalls: { count: 0 },
};

// Use dynamic imports after vi.resetModules() so that transcriber.ts is loaded
// fresh with the mock applied, regardless of test-file execution order when
// isolate:false shares the module cache across files.
let createStreamingTranscriber: typeof import("./transcriber")["createStreamingTranscriber"];
let AsrUnavailableError: typeof import("./transcriber")["AsrUnavailableError"];
let WhisperCppStreamingTranscriber: typeof import("./transcriber")["WhisperCppStreamingTranscriber"];

beforeAll(async () => {
	vi.resetModules?.();
	vi.doMock?.("./whisper-cpp-asr", () => ({
		WHISPER_ELIZA_ADAPTER_ABI_VERSION: 1,
		WHISPER_DEFAULT_LANGUAGE: "en",
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
	}));
	const m = await import("./transcriber");
	createStreamingTranscriber = m.createStreamingTranscriber;
	AsrUnavailableError = m.AsrUnavailableError;
	WhisperCppStreamingTranscriber = m.WhisperCppStreamingTranscriber;
});

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

const FIXTURE_RUNTIME = {
	libraryPath: "/fake/libwhisper_eliza_adapter.so",
	modelPath: "/fake/ggml-base.en.bin",
	language: "en",
	translate: false,
	nThreads: 4,
	useGpu: true,
};

describe("createStreamingTranscriber — whisper.cpp tier", () => {
	it("returns whisper.cpp-backed transcriber when artifacts are on disk (auto chain)", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber({});
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("prefer:'whisper-cpp' throws when no runtime is resolvable", () => {
		mockState.runtimeFixture = null;
		expect(() => createStreamingTranscriber({ prefer: "whisper-cpp" })).toThrow(
			AsrUnavailableError,
		);
	});

	it("prefer:'whisper-cpp' returns the whisper.cpp tier when artifacts present", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber({ prefer: "whisper-cpp" });
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("uses ELIZA_LOCAL_ASR_BACKEND=whisper-cpp as an explicit backend preference", () => {
		process.env.ELIZA_LOCAL_ASR_BACKEND = "whisper-cpp";
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber({});
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
	});

	it("ELIZA_LOCAL_ASR_BACKEND=whisper selects the whisper.cpp tier directly", () => {
		process.env.ELIZA_LOCAL_ASR_BACKEND = "whisper";
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber({});
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
	});

	it("auto chain uses whisper.cpp when artifacts are present and no fused build is available", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		const t = createStreamingTranscriber({});
		expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("auto chain skips whisper.cpp when ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP=false", () => {
		process.env.ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP = "false";
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		expect(() => createStreamingTranscriber({})).toThrow(AsrUnavailableError);
		expect(mockState.disposeCalls.count).toBe(0);
	});

	it("auto chain skips whisper.cpp when allowWhisperCpp=false", () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		expect(() =>
			createStreamingTranscriber({ allowWhisperCpp: false }),
		).toThrow(AsrUnavailableError);
		expect(mockState.disposeCalls.count).toBe(0);
	});

	it("forwards PCM windows from the transcriber to the underlying decoder", async () => {
		mockState.runtimeFixture = FIXTURE_RUNTIME;
		mockState.decoderResponse = "hello world";
		const t = createStreamingTranscriber({ prefer: "whisper-cpp" });
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
