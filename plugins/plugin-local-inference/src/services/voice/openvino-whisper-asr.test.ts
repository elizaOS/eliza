/**
 * Unit tests for the OpenVINO Whisper ASR tier in `createStreamingTranscriber`.
 *
 * Mocks `./openvino-whisper-asr` so the chain logic is exercised without
 * spawning the real Python worker / loading ORT. The standalone integration
 * test in `scripts/test-openvino-whisper-transcriber.mjs` covers the end-to-
 * end runtime with a real WAV file.
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
		pythonBin: string;
		workerScript: string;
		modelDir: string;
		deviceChain: string;
	},
	decoderCalls: [] as Array<Float32Array>,
	disposeCalls: { count: 0 },
};

// Use dynamic imports after vi.resetModules() so that transcriber.ts is loaded
// fresh with the mock applied, regardless of test-file execution order when
// isolate:false shares the module cache across files.
let createStreamingTranscriber: typeof import("./transcriber")["createStreamingTranscriber"];
let AsrUnavailableError: typeof import("./transcriber")["AsrUnavailableError"];
let OpenVinoStreamingTranscriber: typeof import("./transcriber")["OpenVinoStreamingTranscriber"];

beforeAll(async () => {
	vi.resetModules?.();
	vi.doMock?.("./openvino-whisper-asr", () => ({
		OPENVINO_WHISPER_DEFAULT_DEVICE_CHAIN: "NPU,CPU",
		resolveOpenVinoWhisperRuntime: () => mockState.runtimeFixture,
		makeOpenVinoWhisperDecoder: () => ({
			decoder: async (pcm16k: Float32Array): Promise<string> => {
				mockState.decoderCalls.push(pcm16k);
				return "openvino-mock-transcript";
			},
			dispose: () => {
				mockState.disposeCalls.count++;
			},
		}),
	}));
	const m = await import("./transcriber");
	createStreamingTranscriber = m.createStreamingTranscriber;
	AsrUnavailableError = m.AsrUnavailableError;
	OpenVinoStreamingTranscriber = m.OpenVinoStreamingTranscriber;
});

beforeEach(() => {
	mockState.decoderCalls.length = 0;
	mockState.disposeCalls.count = 0;
	mockState.runtimeFixture = null;
});

afterEach(() => {
	mockState.runtimeFixture = null;
	delete process.env.ELIZA_LOCAL_ASR_BACKEND;
	delete process.env.ELIZA_LOCAL_ASR_ALLOW_OPENVINO;
});

describe("createStreamingTranscriber — OpenVINO Whisper tier", () => {
	it("returns OpenVINO-backed transcriber when artifacts are on disk and allowOpenVinoWhisper is set (auto chain)", () => {
		mockState.runtimeFixture = {
			pythonBin: "/fake/python",
			workerScript: "/fake/worker.py",
			modelDir: "/fake/model",
			deviceChain: "NPU,CPU",
		};
		const t = createStreamingTranscriber({ allowOpenVinoWhisper: true });
		expect(t).toBeInstanceOf(OpenVinoStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("prefer:'openvino-whisper' throws when no runtime is resolvable", () => {
		mockState.runtimeFixture = null;
		expect(() =>
			createStreamingTranscriber({ prefer: "openvino-whisper" }),
		).toThrow(AsrUnavailableError);
	});

	it("prefer:'openvino-whisper' returns the OpenVINO tier when artifacts present", () => {
		mockState.runtimeFixture = {
			pythonBin: "/fake/python",
			workerScript: "/fake/worker.py",
			modelDir: "/fake/model",
			deviceChain: "NPU,CPU",
		};
		const t = createStreamingTranscriber({ prefer: "openvino-whisper" });
		expect(t).toBeInstanceOf(OpenVinoStreamingTranscriber);
		t.dispose();
	});

	it("uses ELIZA_LOCAL_ASR_BACKEND=openvino-whisper as an explicit backend preference", () => {
		process.env.ELIZA_LOCAL_ASR_BACKEND = "openvino-whisper";
		mockState.runtimeFixture = {
			pythonBin: "/fake/python",
			workerScript: "/fake/worker.py",
			modelDir: "/fake/model",
			deviceChain: "NPU,CPU",
		};
		const t = createStreamingTranscriber({});
		expect(t).toBeInstanceOf(OpenVinoStreamingTranscriber);
		t.dispose();
	});

	it("ELIZA_LOCAL_ASR_BACKEND=openvino selects the OpenVINO tier directly", () => {
		process.env.ELIZA_LOCAL_ASR_BACKEND = "openvino";
		mockState.runtimeFixture = {
			pythonBin: "/fake/python",
			workerScript: "/fake/worker.py",
			modelDir: "/fake/model",
			deviceChain: "NPU,CPU",
		};
		const t = createStreamingTranscriber({});
		expect(t).toBeInstanceOf(OpenVinoStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("auto chain uses OpenVINO by default when artifacts are present and no fused build is available", () => {
		mockState.runtimeFixture = {
			pythonBin: "/fake/python",
			workerScript: "/fake/worker.py",
			modelDir: "/fake/model",
			deviceChain: "NPU,CPU",
		};
		const t = createStreamingTranscriber({});
		expect(t).toBeInstanceOf(OpenVinoStreamingTranscriber);
		t.dispose();
		expect(mockState.disposeCalls.count).toBe(1);
	});

	it("auto chain skips OpenVINO when ELIZA_LOCAL_ASR_ALLOW_OPENVINO disables it", () => {
		process.env.ELIZA_LOCAL_ASR_ALLOW_OPENVINO = "false";
		mockState.runtimeFixture = {
			pythonBin: "/fake/python",
			workerScript: "/fake/worker.py",
			modelDir: "/fake/model",
			deviceChain: "NPU,CPU",
		};
		expect(() => createStreamingTranscriber({})).toThrow(AsrUnavailableError);
		expect(mockState.disposeCalls.count).toBe(0);
	});

	it("auto chain skips OpenVINO when allowOpenVinoWhisper is explicitly false", () => {
		mockState.runtimeFixture = {
			pythonBin: "/fake/python",
			workerScript: "/fake/worker.py",
			modelDir: "/fake/model",
			deviceChain: "NPU,CPU",
		};
		expect(() =>
			createStreamingTranscriber({ allowOpenVinoWhisper: false }),
		).toThrow(AsrUnavailableError);
		expect(mockState.disposeCalls.count).toBe(0);
	});
});
