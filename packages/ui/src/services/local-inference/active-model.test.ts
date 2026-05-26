import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isForkOnlyKvCacheType,
  isStockKvCacheType,
  resolveLocalInferenceLoadArgs,
  validateLocalInferenceLoadArgs,
} from "./active-model";
import type { InstalledModel } from "./types";

function makeInstalledModel(
  id: string,
  filePath: string,
  bundleRoot?: string,
): InstalledModel {
  return {
    id,
    displayName: id,
    path: filePath,
    sizeBytes: 1024,
    bundleRoot,
    installedAt: "2026-05-08T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
  };
}

function makeTempElizaBundle(
  tier: string,
  options: { hasMtp?: boolean } = {},
): { bundleRoot: string; textPath: string; drafterPath: string } {
  const bundleRoot = mkdtempSync(pathJoin(tmpdir(), "eliza-ui-mtp-"));
  mkdirSync(pathJoin(bundleRoot, "text"), { recursive: true });
  const textPath = pathJoin(bundleRoot, "text", `eliza-1-${tier}-32k.gguf`);
  const drafterPath = pathJoin(
    bundleRoot,
    "mtp",
    `eliza-1-${tier}-drafter.gguf`,
  );
  writeFileSync(textPath, "fake-text-gguf");
  if (options.hasMtp !== false) {
    mkdirSync(pathJoin(bundleRoot, "mtp"), { recursive: true });
    writeFileSync(drafterPath, "fake-mtp-drafter-gguf");
  }
  return { bundleRoot, textPath, drafterPath };
}

describe("resolveLocalInferenceLoadArgs", () => {
  it("threads catalog contextLength into loader args when no override is given", async () => {
    const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
    const args = await resolveLocalInferenceLoadArgs(target);
    expect(args.contextSize).toBe(131072);
  });

  it("per-load contextSize override beats catalog contextLength default", async () => {
    const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
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

  it("preserves kvOffload overrides for backend load resolution", async () => {
    const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
    const args = await resolveLocalInferenceLoadArgs(target, {
      kvOffload: { gpuLayers: 10 },
    });
    expect(args.kvOffload).toEqual({ gpuLayers: 10 });
  });

  it("resolves the bundled MTP drafter path for every autoregressive Eliza-1 tier", async () => {
    const bundle = makeTempElizaBundle("0_8b");
    try {
      const target = makeInstalledModel(
        "eliza-1-0_8b",
        bundle.textPath,
        bundle.bundleRoot,
      );
      const args = await resolveLocalInferenceLoadArgs(target);
      expect(args.draftModelPath).toBe(bundle.drafterPath);
      expect(args.draftMin).toBeGreaterThan(0);
      expect(args.draftMax).toBeGreaterThan(0);
      expect(args.mobileSpeculative).toBe(true);
    } finally {
      rmSync(bundle.bundleRoot, { recursive: true, force: true });
    }
  });

  it("throws when an MTP-enabled Eliza-1 bundle is missing its drafter", async () => {
    const bundle = makeTempElizaBundle("0_8b", { hasMtp: false });
    try {
      const target = makeInstalledModel(
        "eliza-1-0_8b",
        bundle.textPath,
        bundle.bundleRoot,
      );
      await expect(resolveLocalInferenceLoadArgs(target)).rejects.toThrow(
        /mandatory MTP/,
      );
    } finally {
      rmSync(bundle.bundleRoot, { recursive: true, force: true });
    }
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
    ).toThrow(/elizaOS\/llama\.cpp|fork/i);
    expect(() =>
      validateLocalInferenceLoadArgs(
        { cacheTypeV: "qjl1_256" },
        { allowFork: false },
      ),
    ).toThrow(/elizaOS\/llama\.cpp|fork/i);
  });

  it("accepts fork KV cache types when allowFork is true (AOSP path)", () => {
    expect(() =>
      validateLocalInferenceLoadArgs(
        { cacheTypeK: "q4_polar", cacheTypeV: "tbq3_0" },
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
    expect(isForkOnlyKvCacheType("q4_polar")).toBe(true);
    expect(isForkOnlyKvCacheType("f16")).toBe(false);
    expect(isForkOnlyKvCacheType(undefined)).toBe(false);
  });

  it("identifies stock KV cache types", () => {
    expect(isStockKvCacheType("f16")).toBe(true);
    expect(isStockKvCacheType("q8_0")).toBe(true);
    expect(isStockKvCacheType("bf16")).toBe(true);
    expect(isStockKvCacheType("q4_polar")).toBe(false);
    expect(isStockKvCacheType("tbq4_0")).toBe(false);
    expect(isStockKvCacheType(undefined)).toBe(false);
  });
});
