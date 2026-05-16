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

// Shared mock state. `vi.hoisted` runs before any `import` so this object
// is reachable from both the `vi.mock` factory below and from each test's
// `beforeEach` — without sharing module-level state with sibling test files
// that may also be importing `./openvino-whisper-asr`.
const mockState = vi.hoisted(() => ({
	runtimeFixture: null as null | {
		pythonBin: string;
		workerScript: string;
		modelDir: string;
		deviceChain: string;
	},
	decoderCalls: [] as Array<Float32Array>,
	disposeCalls: { count: 0 },
}));

vi.mock("./openvino-whisper-asr", () => ({
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

// Use dynamic imports after vi.resetModules() so that transcriber.ts is loaded
// fresh with the mock applied, regardless of test-file execution order when
// isolate:false shares the module cache across files.
let createStreamingTranscriber: typeof import("./transcriber")["createStreamingTranscriber"];
let AsrUnavailableError: typeof import("./transcriber")["AsrUnavailableError"];
let OpenVinoStreamingTranscriber: typeof import("./transcriber")["OpenVinoStreamingTranscriber"];

beforeAll(async () => {
	vi.resetModules();
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
	vi.unstubAllEnvs();
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
