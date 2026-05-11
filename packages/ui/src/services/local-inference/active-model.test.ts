import { describe, expect, it } from "vitest";
import {
  isForkOnlyKvCacheType,
  isStockKvCacheType,
  resolveLocalInferenceLoadArgs,
  validateLocalInferenceLoadArgs,
} from "./active-model";
import type { InstalledModel } from "./types";

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

describe("resolveLocalInferenceLoadArgs", () => {
  it("threads catalog contextLength into loader args when no override is given", async () => {
    const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
    const args = await resolveLocalInferenceLoadArgs(target);
    expect(args.contextSize).toBe(65536);
  });

  it("per-load contextSize override beats catalog contextLength default", async () => {
    const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
    const args = await resolveLocalInferenceLoadArgs(target, {
      contextSize: 32768,
    });
    expect(args.contextSize).toBe(32768);
  });

  it("per-load gpuLayers/flashAttention/mmap/mlock overrides flow into args", async () => {
    const target = makeInstalledModel("eliza-1-1_7b", "/tmp/eliza-1-1_7b.gguf");
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
    expect(() => validateLocalInferenceLoadArgs({ contextSize: 100 })).toThrow(
      /contextSize/,
    );
    expect(() => validateLocalInferenceLoadArgs({ gpuLayers: -1 })).toThrow(
      /gpuLayers/,
    );
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
