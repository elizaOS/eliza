/**
 * Unit tests for the OpenVINO Whisper ASR tier in `createStreamingTranscriber`.
 *
 * Mocks `./openvino-whisper-asr` so the chain logic is exercised without
 * spawning the real Python worker / loading ORT. The standalone integration
 * test in `scripts/test-openvino-whisper-transcriber.mjs` covers the end-to-
 * end runtime with a real WAV file.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let createStreamingTranscriber: (typeof import("./transcriber"))["createStreamingTranscriber"];
let AsrUnavailableError: (typeof import("./transcriber"))["AsrUnavailableError"];
let WhisperCppStreamingTranscriber: (typeof import("./transcriber"))["WhisperCppStreamingTranscriber"];

beforeAll(async () => {
  vi.resetModules();
  const m = await import("./transcriber");
  createStreamingTranscriber = m.createStreamingTranscriber;
  AsrUnavailableError = m.AsrUnavailableError;
  WhisperCppStreamingTranscriber = m.WhisperCppStreamingTranscriber;
});

beforeEach(() => {
  mockState.decoderCalls.length = 0;
  mockState.disposeCalls.count = 0;
  mockState.runtimeFixture = null;
});

afterEach(() => {
  mockState.runtimeFixture = null;
});

describe("createStreamingTranscriber — OpenVINO Whisper tier", () => {
  it("returns OpenVINO-backed transcriber when artifacts are on disk and chain is auto", () => {
    mockState.runtimeFixture = {
      pythonBin: "/fake/python",
      workerScript: "/fake/worker.py",
      modelDir: "/fake/model",
      deviceChain: "NPU,CPU",
    };
    const t = createStreamingTranscriber({});
    // The OpenVINO tier reuses WhisperCppStreamingTranscriber's sliding-
    // window engine — the marker is the *injected decoder*, not the class.
    expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
    t.dispose();
    expect(mockState.disposeCalls.count).toBe(1);
  });

  it("falls through to whisper.cpp when no OpenVINO runtime is resolvable", () => {
    mockState.runtimeFixture = null;
    const t = createStreamingTranscriber({
      whisper: { decoder: async () => "whisper-cpp-fallback" },
    });
    expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
    t.dispose();
    expect(mockState.disposeCalls.count).toBe(0); // no OpenVINO worker to dispose
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
    expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
    t.dispose();
  });

  it("allowOpenVinoWhisper:false skips the OpenVINO tier and falls through to whisper.cpp", () => {
    mockState.runtimeFixture = {
      pythonBin: "/fake/python",
      workerScript: "/fake/worker.py",
      modelDir: "/fake/model",
      deviceChain: "NPU,CPU",
    };
    const t = createStreamingTranscriber({
      allowOpenVinoWhisper: false,
      whisper: { decoder: async () => "whisper-cpp-fallback" },
    });
    expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
    // The dispose hook is from the OpenVINO tier — should NOT fire when we
    // skip it and use whisper.cpp instead.
    t.dispose();
    expect(mockState.disposeCalls.count).toBe(0);
  });

  it("allowWhisperFallback:false implicitly blocks OpenVINO (both are non-fused fallbacks)", () => {
    mockState.runtimeFixture = {
      pythonBin: "/fake/python",
      workerScript: "/fake/worker.py",
      modelDir: "/fake/model",
      deviceChain: "NPU,CPU",
    };
    expect(() =>
      createStreamingTranscriber({
        allowWhisperFallback: false,
        whisper: { decoder: async () => "whisper-cpp-fallback" },
      }),
    ).toThrow(AsrUnavailableError);
  });

  it("allowOpenVinoWhisper:true overrides allowWhisperFallback:false (caller is explicit)", () => {
    mockState.runtimeFixture = {
      pythonBin: "/fake/python",
      workerScript: "/fake/worker.py",
      modelDir: "/fake/model",
      deviceChain: "NPU,CPU",
    };
    const t = createStreamingTranscriber({
      allowWhisperFallback: false,
      allowOpenVinoWhisper: true,
    });
    expect(t).toBeInstanceOf(WhisperCppStreamingTranscriber);
    t.dispose();
  });
});
