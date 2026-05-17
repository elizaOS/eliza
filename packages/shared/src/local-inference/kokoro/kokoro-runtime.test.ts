import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KokoroOnnxRuntime } from "./kokoro-runtime.js";
import type { KokoroModelLayout, KokoroVoicePack } from "./types.js";

type StubFeeds = Record<
  string,
  {
    type: string;
    dims: ReadonlyArray<number>;
    data: Float32Array | Int32Array | BigInt64Array;
  }
>;

function makeStubOrt(): {
  ort: unknown;
  captured: { createOptions: Record<string, unknown> | null };
} {
  const captured: { createOptions: Record<string, unknown> | null } = {
    createOptions: null,
  };
  const session = {
    inputNames: ["input_ids", "style", "speed"],
    async run(_feeds: StubFeeds) {
      return {
        waveform: {
          type: "float32",
          data: new Float32Array([0.1, -0.1]),
          dims: [2],
        },
      };
    },
    async release() {},
  };
  const ort = {
    InferenceSession: {
      create: async (_modelPath: string, opts?: Record<string, unknown>) => {
        captured.createOptions = opts ?? null;
        return session;
      },
    },
    Tensor: function (
      this: { type: string; data: unknown; dims: ReadonlyArray<number> },
      type: string,
      data: unknown,
      dims: ReadonlyArray<number>,
    ) {
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

function stageBundle(): {
  layout: KokoroModelLayout;
  voice: KokoroVoicePack;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "kokoro-runtime-test-"));
  const voicesDir = path.join(root, "voices");
  mkdirSync(voicesDir, { recursive: true });
  writeFileSync(path.join(root, "model.onnx"), Buffer.alloc(4));
  writeFileSync(
    path.join(voicesDir, "af_test.bin"),
    Buffer.from(new Float32Array([1, 2, 3, 4]).buffer),
  );
  return {
    layout: { root, modelFile: "model.onnx", voicesDir, sampleRate: 24000 },
    voice: {
      id: "af_test",
      displayName: "Test",
      lang: "a",
      file: "af_test.bin",
      dim: 4,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("KokoroOnnxRuntime execution provider", () => {
  let cleanups: Array<() => void>;

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it("keeps CPU as the default ORT execution provider", async () => {
    const fx = stageBundle();
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt();
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });

    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([1, 2]), phonemes: "ab" },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });

    expect(captured.createOptions?.executionProviders).toEqual(["cpu"]);
  });

  it("passes an explicit NNAPI provider into ORT session options", async () => {
    const fx = stageBundle();
    cleanups.push(fx.cleanup);
    const { ort, captured } = makeStubOrt();
    const runtime = new KokoroOnnxRuntime({
      layout: fx.layout,
      executionProvider: "nnapi",
      expectedSha256: null,
      loadOrt: async () => ort as never,
    });

    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([1, 2]), phonemes: "ab" },
      voice: fx.voice,
      cancelSignal: { cancelled: false },
      onChunk: () => false,
    });

    expect(captured.createOptions?.executionProviders).toEqual(["nnapi"]);
  });
});
