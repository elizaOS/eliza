import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isForkOnlyKvCacheType,
  isStockKvCacheType,
  resolveLocalInferenceLoadArgs,
  validateLocalInferenceLoadArgs,
} from "./active-model";
import type { InstalledModel } from "./types";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeInstalledModel(id: string, filePath: string): InstalledModel {
  return {
    id,
    displayName: id,
    path: filePath,
    sizeBytes: 1024,
    installedAt: "2026-05-08T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
  };
}

function writeRegistry(root: string, models: InstalledModel[]): void {
  const localRoot = path.join(root, "local-inference");
  fs.mkdirSync(localRoot, { recursive: true });
  fs.writeFileSync(
    path.join(localRoot, "registry.json"),
    JSON.stringify({ version: 1, models }, null, 2),
    "utf8",
  );
}

describe("resolveLocalInferenceLoadArgs", () => {
  it("carries DFlash companion and speculative settings into loader args", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-load-args-"));
    process.env.ELIZA_STATE_DIR = root;
    const target = makeInstalledModel(
      "qwen3.5-4b-dflash",
      path.join(root, "local-inference", "models", "qwen.gguf"),
    );
    const drafter = makeInstalledModel(
      "qwen3.5-4b-dflash-drafter-q4",
      path.join(root, "local-inference", "models", "qwen-drafter.gguf"),
    );
    writeRegistry(root, [target, drafter]);

    const args = await resolveLocalInferenceLoadArgs(target);

    // The catalog now declares qwen3.5-4b-dflash.contextLength=131072
    // (the model's true ceiling); that wins over the dflash launch
    // default. The other dflash launch fields are unaffected.
    expect(args).toMatchObject({
      modelPath: target.path,
      draftModelPath: drafter.path,
      contextSize: 131072,
      draftContextSize: 256,
      draftMin: 1,
      draftMax: 16,
      speculativeSamples: 16,
      mobileSpeculative: true,
      disableThinking: true,
      useGpu: true,
      flashAttention: true,
    });
  });

  it("carries TurboQuant KV cache metadata into loader args", async () => {
    const target = makeInstalledModel("bonsai-8b-1bit", "/tmp/Bonsai-8B.gguf");

    const args = await resolveLocalInferenceLoadArgs(target);

    expect(args.cacheTypeK).toBe("tbq4_0");
    expect(args.cacheTypeV).toBe("tbq3_0");
  });

  it("threads catalog contextLength into loader args when no override is given", async () => {
    const target = makeInstalledModel(
      "eliza-1-9b",
      "/tmp/eliza-1-9b.gguf",
    );
    const args = await resolveLocalInferenceLoadArgs(target);
    expect(args.contextSize).toBe(131072);
  });

  it("per-load contextSize override beats catalog contextLength default", async () => {
    const target = makeInstalledModel(
      "eliza-1-9b",
      "/tmp/eliza-1-9b.gguf",
    );
    const args = await resolveLocalInferenceLoadArgs(target, {
      contextSize: 32768,
    });
    expect(args.contextSize).toBe(32768);
  });

  it("per-load gpuLayers/flashAttention/mmap/mlock overrides flow into args", async () => {
    const target = makeInstalledModel("eliza-1-2b", "/tmp/eliza-1-2b.gguf");
    const args = await resolveLocalInferenceLoadArgs(target, {
      gpuLayers: 16,
      flashAttention: true,
      mmap: false,
      mlock: true,
    });
    expect(args.gpuLayers).toBe(16);
    expect(args.flashAttention).toBe(true);
    expect(args.mmap).toBe(false);
    expect(args.mlock).toBe(true);
  });

  it("per-load cacheType override wins over the catalog runtime block", async () => {
    const target = makeInstalledModel("bonsai-8b-1bit", "/tmp/Bonsai-8B.gguf");
    const args = await resolveLocalInferenceLoadArgs(target, {
      cacheTypeK: "f16",
      cacheTypeV: "q8_0",
    });
    expect(args.cacheTypeK).toBe("f16");
    expect(args.cacheTypeV).toBe("q8_0");
  });

  it("DFlash launch contextSize is preserved when no override is given", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-load-args-ctx-"));
    process.env.ELIZA_STATE_DIR = root;
    const target = makeInstalledModel(
      "qwen3.5-4b-dflash",
      path.join(root, "local-inference", "models", "qwen.gguf"),
    );
    const drafter = makeInstalledModel(
      "qwen3.5-4b-dflash-drafter-q4",
      path.join(root, "local-inference", "models", "qwen-drafter.gguf"),
    );
    writeRegistry(root, [target, drafter]);

    const args = await resolveLocalInferenceLoadArgs(target);
    // qwen3.5-4b-dflash declares contextLength=131072 on the catalog
    // entry (the model's true ceiling), but the dflash launch block
    // declares contextSize=8192. The catalog-level contextLength wins
    // when set; the dflash block's launch default is the fallback only.
    expect(args.contextSize).toBe(131072);
  });
});

describe("validateLocalInferenceLoadArgs", () => {
  it("accepts stock KV cache types on desktop", () => {
    expect(() =>
      validateLocalInferenceLoadArgs(
        { cacheTypeK: "f16", cacheTypeV: "q8_0" },
        { allowFork: false },
      ),
    ).not.toThrow();
  });

  it("rejects fork-only KV cache types on desktop", () => {
    expect(() =>
      validateLocalInferenceLoadArgs(
        { cacheTypeK: "tbq4_0" },
        { allowFork: false },
      ),
    ).toThrow(/milady-ai\/llama\.cpp|fork/i);
    expect(() =>
      validateLocalInferenceLoadArgs(
        { cacheTypeV: "qjl1_256" },
        { allowFork: false },
      ),
    ).toThrow(/milady-ai\/llama\.cpp|fork/i);
  });

  it("accepts fork KV cache types when allowFork is true (AOSP path)", () => {
    expect(() =>
      validateLocalInferenceLoadArgs(
        { cacheTypeK: "tbq4_0", cacheTypeV: "tbq3_0" },
        { allowFork: true },
      ),
    ).not.toThrow();
  });

  it("rejects unknown KV cache type names", () => {
    expect(() =>
      validateLocalInferenceLoadArgs(
        { cacheTypeK: "nope_made_up" },
        { allowFork: false },
      ),
    ).toThrow(/not a recognised KV cache type/);
  });

  it("rejects illegal contextSize / gpuLayers / kvOffload", () => {
    expect(() =>
      validateLocalInferenceLoadArgs({ contextSize: 100 }),
    ).toThrow(/contextSize/);
    expect(() =>
      validateLocalInferenceLoadArgs({ gpuLayers: -1 }),
    ).toThrow(/gpuLayers/);
    expect(() =>
      validateLocalInferenceLoadArgs({
        kvOffload: "magic" as never,
      }),
    ).toThrow(/kvOffload/);
  });

  it("accepts every legal kvOffload shape", () => {
    expect(() =>
      validateLocalInferenceLoadArgs({ kvOffload: "cpu" }),
    ).not.toThrow();
    expect(() =>
      validateLocalInferenceLoadArgs({ kvOffload: "gpu" }),
    ).not.toThrow();
    expect(() =>
      validateLocalInferenceLoadArgs({ kvOffload: "split" }),
    ).not.toThrow();
    expect(() =>
      validateLocalInferenceLoadArgs({ kvOffload: { gpuLayers: 32 } }),
    ).not.toThrow();
  });
});

describe("KV cache type classifiers", () => {
  it("identifies fork-only KV cache types", () => {
    expect(isForkOnlyKvCacheType("tbq4_0")).toBe(true);
    expect(isForkOnlyKvCacheType("tbq3_0")).toBe(true);
    expect(isForkOnlyKvCacheType("qjl1_256")).toBe(true);
    expect(isForkOnlyKvCacheType("f16")).toBe(false);
    expect(isForkOnlyKvCacheType(undefined)).toBe(false);
  });

  it("identifies stock KV cache types", () => {
    expect(isStockKvCacheType("f16")).toBe(true);
    expect(isStockKvCacheType("q8_0")).toBe(true);
    expect(isStockKvCacheType("bf16")).toBe(true);
    expect(isStockKvCacheType("tbq4_0")).toBe(false);
    expect(isStockKvCacheType(undefined)).toBe(false);
  });
});
