import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KokoroOnnxRuntime } from "../kokoro-runtime";
import { KokoroModelMissingError, type KokoroVoicePack } from "../types";

// Stub ORT module — captures the feeds the runtime constructs without
// running real onnxruntime-node. Mirrors the structural shape declared in
// kokoro-runtime.ts (`OrtModule`).
function makeStubOrt(args: {
  inputNames?: ReadonlyArray<string>;
  waveform?: Float32Array;
  captured?: { feeds: Record<string, { type: string; dims: ReadonlyArray<number>; data: Float32Array | Int32Array | BigInt64Array; }> | null };
}): { ort: unknown; captured: typeof args.captured } {
  const captured = args.captured ?? { feeds: null };
  const waveform = args.waveform ?? new Float32Array([0.1, -0.1, 0.2, -0.2]);
  const session = {
    inputNames: args.inputNames,
    async run(feeds: Record<string, { type: string; dims: ReadonlyArray<number>; data: Float32Array | Int32Array | BigInt64Array }>) {
      captured.feeds = feeds;
      return { waveform: { type: "float32", data: waveform, dims: [waveform.length] } };
    },
    async release() {},
  };
  const ort = {
    InferenceSession: { create: async () => session },
    Tensor: function (this: { type: string; data: unknown; dims: ReadonlyArray<number> }, type: string, data: unknown, dims: ReadonlyArray<number>) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    } as unknown as new (
      type: string,
      data: Float32Array | Int32Array | BigInt64Array,
      dims: ReadonlyArray<number>,
    ) => { type: string; data: unknown; dims: ReadonlyArray<number> },
  };
  return { ort, captured };
}

function stageBundle(dim: number, voiceBytes: Float32Array): {
  layout: { root: string; modelFile: string; voicesDir: string; sampleRate: number };
  voice: KokoroVoicePack;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "kokoro-runtime-test-"));
  const voicesDir = path.join(root, "voices");
  mkdirSync(voicesDir, { recursive: true });
  const modelFile = "model.onnx";
  // The ORT loader checks the file exists before calling InferenceSession.
  writeFileSync(path.join(root, modelFile), Buffer.alloc(4));
  writeFileSync(
    path.join(voicesDir, "af_test.bin"),
    Buffer.from(voiceBytes.buffer, voiceBytes.byteOffset, voiceBytes.byteLength),
  );
  return {
    layout: { root, modelFile, voicesDir, sampleRate: 24000 },
    voice: { id: "af_test", displayName: "Test", lang: "a", file: "af_test.bin", dim, tags: ["test"] },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("KokoroOnnxRuntime — voice .bin loader formats", () => {
  let cleanups: Array<() => void>;
  beforeEach(() => { cleanups = []; });
  afterEach(() => { for (const c of cleanups) c(); });

  it("loads the legacy single-style format (exactly voice.dim fp32)", async () => {
    const dim = 4;
    const single = new Float32Array([1, 2, 3, 4]);
    const fx = stageBundle(dim, single);
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt({ inputNames: ["input_ids", "style", "speed"] });
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([10, 20, 30]), phonemes: "abc" },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });
    expect(captured!.feeds).not.toBeNull();
    const styleFeed = captured!.feeds!.style;
    expect(Array.from(styleFeed.data as Float32Array)).toEqual([1, 2, 3, 4]);
    expect(styleFeed.dims).toEqual([1, 4]);
  });

  it("slices the per-position format using kokoro-onnx's `voice[len(tokens)]` rule", async () => {
    const dim = 4;
    const positions = 5;
    // Build a 5×4 tensor where position k holds [k, k+0.1, k+0.2, k+0.3].
    const full = new Float32Array(positions * dim);
    for (let i = 0; i < positions; i++) {
      for (let j = 0; j < dim; j++) full[i * dim + j] = i * 100 + j;
    }
    const fx = stageBundle(dim, full);
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt({ inputNames: ["input_ids", "style", "speed"] });
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });
    // 3 phoneme tokens → should pick position 3.
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([10, 20, 30]), phonemes: "abc" },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });
    const styleFeed = captured!.feeds!.style;
    expect(Array.from(styleFeed.data as Float32Array)).toEqual([300, 301, 302, 303]);
    expect(styleFeed.dims).toEqual([1, 4]);
  });

  it("clamps position index to numPositions - 1 when tokens exceed the table", async () => {
    const dim = 4;
    const positions = 3;
    const full = new Float32Array(positions * dim);
    for (let i = 0; i < positions; i++) {
      for (let j = 0; j < dim; j++) full[i * dim + j] = i * 100 + j;
    }
    const fx = stageBundle(dim, full);
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt({ inputNames: ["input_ids", "style", "speed"] });
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });
    // 20 phoneme tokens, table has 3 positions → pick position 2 (last).
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from(new Array(20).fill(7)), phonemes: "x".repeat(20) },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });
    const styleFeed = captured!.feeds!.style;
    expect(Array.from(styleFeed.data as Float32Array)).toEqual([200, 201, 202, 203]);
  });

  it("rejects a voice .bin whose length is not a positive multiple of voice.dim", async () => {
    const dim = 4;
    const malformed = new Float32Array([1, 2, 3]); // 3 fp32 (not a multiple of 4)
    const fx = stageBundle(dim, malformed);
    cleanups.push(fx.cleanup);
    const { ort } = makeStubOrt({ inputNames: ["input_ids", "style", "speed"] });
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });
    await expect(
      runtime.synthesize({
        phonemes: { ids: Int32Array.from([1]), phonemes: "a" },
        voice: fx.voice,
        cancelSignal: { cancelled: false },
        onChunk: () => false,
      }),
    ).rejects.toBeInstanceOf(KokoroModelMissingError);
  });
});

describe("KokoroOnnxRuntime — ONNX input-name detection", () => {
  let cleanups: Array<() => void>;
  beforeEach(() => { cleanups = []; });
  afterEach(() => { for (const c of cleanups) c(); });

  it("feeds `input_ids` when the session advertises it (newer export)", async () => {
    const fx = stageBundle(4, new Float32Array([1, 1, 1, 1]));
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt({ inputNames: ["input_ids", "style", "speed"] });
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([42, 43]), phonemes: "ab" },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });
    expect(Object.keys(captured!.feeds!)).toContain("input_ids");
    expect(Object.keys(captured!.feeds!)).not.toContain("tokens");
  });

  it("feeds `tokens` when the session lacks `input_ids` (older kokoro-onnx export)", async () => {
    const fx = stageBundle(4, new Float32Array([1, 1, 1, 1]));
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt({ inputNames: ["tokens", "style", "speed"] });
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([42, 43]), phonemes: "ab" },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });
    expect(Object.keys(captured!.feeds!)).toContain("tokens");
    expect(Object.keys(captured!.feeds!)).not.toContain("input_ids");
  });

  it("defaults to `input_ids` when the session does not report input names (test stubs without inputNames)", async () => {
    const fx = stageBundle(4, new Float32Array([1, 1, 1, 1]));
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt({});
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([42, 43]), phonemes: "ab" },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });
    expect(Object.keys(captured!.feeds!)).toContain("input_ids");
  });
});
