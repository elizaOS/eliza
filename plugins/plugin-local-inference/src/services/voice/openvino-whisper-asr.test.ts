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
		// `transcriber.ts` queries this to decide what error to throw on
		// unsupported arches. The mock returns `true` so the rest of the
		// existing tests (which simulate x86_64 / arm64 environments) hit
		// the same codepaths they did before this gate landed. Riscv64
		// behavior is covered separately by direct (unmocked) calls to
		// `isOpenVinoSupportedArch` below.
		isOpenVinoSupportedArch: () => true,
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
	delete process.env.ELIZA_LOCAL_ASR_RISCV64_ALLOW_OPENVINO;
});

describe("isOpenVinoSupportedArch — arch gate", () => {
	// These tests need the *real* implementation, not the module-level mock
	// installed above for `createStreamingTranscriber` chain tests. We load it
	// via vi.importActual so the gate logic is exercised directly.
	let isOpenVinoSupportedArch: (
		arch?: NodeJS.Architecture,
		env?: NodeJS.ProcessEnv,
	) => boolean;
	let resolveOpenVinoWhisperRuntime: () => unknown;

	beforeAll(async () => {
		const actual = await vi.importActual<
			typeof import("./openvino-whisper-asr")
		>("./openvino-whisper-asr");
		isOpenVinoSupportedArch = actual.isOpenVinoSupportedArch;
		resolveOpenVinoWhisperRuntime = actual.resolveOpenVinoWhisperRuntime;
	});

	it("allows x64 and arm64 (the OpenVINO PyPI wheel set)", () => {
		expect(isOpenVinoSupportedArch("x64", {})).toBe(true);
		expect(isOpenVinoSupportedArch("arm64", {})).toBe(true);
	});

	it("refuses riscv64 by default — no OpenVINO wheel ships for that arch", () => {
		expect(isOpenVinoSupportedArch("riscv64", {})).toBe(false);
	});

	it("permits riscv64 only when ELIZA_LOCAL_ASR_RISCV64_ALLOW_OPENVINO=1", () => {
		expect(
			isOpenVinoSupportedArch("riscv64", {
				ELIZA_LOCAL_ASR_RISCV64_ALLOW_OPENVINO: "1",
			}),
		).toBe(true);
		expect(
			isOpenVinoSupportedArch("riscv64", {
				ELIZA_LOCAL_ASR_RISCV64_ALLOW_OPENVINO: "true",
			}),
		).toBe(true);
		expect(
			isOpenVinoSupportedArch("riscv64", {
				ELIZA_LOCAL_ASR_RISCV64_ALLOW_OPENVINO: "0",
			}),
		).toBe(false);
		expect(
			isOpenVinoSupportedArch("riscv64", {
				ELIZA_LOCAL_ASR_RISCV64_ALLOW_OPENVINO: "",
			}),
		).toBe(false);
	});

	it("refuses other exotic arches (ppc64, s390x, mips) outright", () => {
		expect(isOpenVinoSupportedArch("ppc64" as NodeJS.Architecture, {})).toBe(
			false,
		);
		expect(isOpenVinoSupportedArch("s390x" as NodeJS.Architecture, {})).toBe(
			false,
		);
		expect(isOpenVinoSupportedArch("mips" as NodeJS.Architecture, {})).toBe(
			false,
		);
	});

	it("resolveOpenVinoWhisperRuntime short-circuits to null on riscv64 hosts without the opt-in env", () => {
		// Only meaningful when actually running on riscv64. On supported
		// arches the resolver returns null only when artifacts are missing,
		// which is environment-dependent — we just assert no throw here.
		if (process.arch === "riscv64") {
			expect(resolveOpenVinoWhisperRuntime()).toBeNull();
		} else {
			expect(() => resolveOpenVinoWhisperRuntime()).not.toThrow();
		}
	});
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
