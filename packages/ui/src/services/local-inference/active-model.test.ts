/**
 * Unit coverage for local-inference load-arg resolution and KV-cache-type
 * validation (stock vs fork-only). Pure functions over a temp dir, no engine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isForkOnlyKvCacheType,
  isStockKvCacheType,
  resolveLocalInferenceLoadArgs,
  validateLocalInferenceLoadArgs,
} from "./active-model";
import {
  ELIZA_1_HOSTED_MTP_TIER_IDS,
  ELIZA_1_MTP_TIER_IDS,
  findCatalogModel,
} from "./catalog";
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
  // Shape a separate-drafter MTP file. The resolver wires it only for tiers
  // whose drafter is hosted in the shared catalog (ELIZA_1_HOSTED_MTP_TIER_IDS)
  // and ignores stray on-disk drafters for every other tier.
  const drafterPath = pathJoin(bundleRoot, "mtp", `drafter-${tier}.gguf`);
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

  it("clamps the context window to the mobile ceiling on iOS/Android", async () => {
    const prev = process.env.ELIZA_MOBILE_PLATFORM;
    process.env.ELIZA_MOBILE_PLATFORM = "ios";
    try {
      const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
      // Catalog ceiling is 131072; on mobile it must clamp to the 8192 default.
      const args = await resolveLocalInferenceLoadArgs(target);
      expect(args.contextSize).toBe(8192);
      // An explicit override above the ceiling is clamped too — a phone cannot
      // hold the KV cache regardless of what was requested.
      const overridden = await resolveLocalInferenceLoadArgs(target, {
        contextSize: 32768,
      });
      expect(overridden.contextSize).toBe(8192);
    } finally {
      if (prev === undefined) delete process.env.ELIZA_MOBILE_PLATFORM;
      else process.env.ELIZA_MOBILE_PLATFORM = prev;
    }
  });

  it("honors ELIZA_MOBILE_CONTEXT_CEILING override for capable devices", async () => {
    const prevPlat = process.env.ELIZA_MOBILE_PLATFORM;
    const prevCeil = process.env.ELIZA_MOBILE_CONTEXT_CEILING;
    process.env.ELIZA_MOBILE_PLATFORM = "android";
    process.env.ELIZA_MOBILE_CONTEXT_CEILING = "16384";
    try {
      const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
      const args = await resolveLocalInferenceLoadArgs(target);
      expect(args.contextSize).toBe(16384);
    } finally {
      if (prevPlat === undefined) delete process.env.ELIZA_MOBILE_PLATFORM;
      else process.env.ELIZA_MOBILE_PLATFORM = prevPlat;
      if (prevCeil === undefined)
        delete process.env.ELIZA_MOBILE_CONTEXT_CEILING;
      else process.env.ELIZA_MOBILE_CONTEXT_CEILING = prevCeil;
    }
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

  it("enables MTP args for hosted-drafter tiers whose drafter GGUF is bundled", async () => {
    expect(ELIZA_1_HOSTED_MTP_TIER_IDS.length).toBeGreaterThan(0);
    for (const id of ELIZA_1_HOSTED_MTP_TIER_IDS) {
      const tier = id.replace("eliza-1-", "");
      const bundle = makeTempElizaBundle(tier);
      const target = makeInstalledModel(id, bundle.textPath, bundle.bundleRoot);
      const mtp = findCatalogModel(id)?.runtime?.mtp;
      expect(mtp?.specType).toBe("draft-mtp");
      try {
        const args = await resolveLocalInferenceLoadArgs(target);
        expect(args.draftModelPath).toBe(bundle.drafterPath);
        expect(args.draftMin).toBe(mtp?.draftMin);
        expect(args.draftMax).toBe(mtp?.draftMax);
        expect(args.mobileSpeculative).toBe(true);
      } finally {
        rmSync(bundle.bundleRoot, { recursive: true, force: true });
      }
    }
  });

  it("ignores a stray on-disk drafter for tiers without a hosted Gemma drafter", async () => {
    const hosted = new Set<string>(ELIZA_1_HOSTED_MTP_TIER_IDS);
    const unhosted = ELIZA_1_MTP_TIER_IDS.filter((id) => !hosted.has(id));
    expect(unhosted.length).toBeGreaterThan(0);
    for (const id of unhosted) {
      const tier = id.replace("eliza-1-", "");
      const bundle = makeTempElizaBundle(tier);
      const target = makeInstalledModel(id, bundle.textPath, bundle.bundleRoot);
      try {
        const args = await resolveLocalInferenceLoadArgs(target);
        expect(args.draftModelPath).toBeUndefined();
        expect(args.draftMin).toBeUndefined();
        expect(args.draftMax).toBeUndefined();
        expect(args.mobileSpeculative).toBeUndefined();
      } finally {
        rmSync(bundle.bundleRoot, { recursive: true, force: true });
      }
    }
  });

  it("falls back to a non-speculative load when a pre-cutover bundle is missing the drafter GGUF", async () => {
    // Back-compat (#11517): a bundle installed BEFORE the Gemma-4 MTP cutover
    // has no `mtp/drafter-*.gguf` on disk. The drafter is a perf-only
    // speculative-decoding artifact, so the model must still load (warn +
    // plain decode) — never hard-throw and brick the install.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bundle = makeTempElizaBundle("2b", { hasMtp: false });
    try {
      const target = makeInstalledModel(
        "eliza-1-2b",
        bundle.textPath,
        bundle.bundleRoot,
      );
      const args = await resolveLocalInferenceLoadArgs(target);
      expect(args.modelPath).toBe(bundle.textPath);
      expect(args.draftModelPath).toBeUndefined();
      expect(args.draftMin).toBeUndefined();
      expect(args.draftMax).toBeUndefined();
      expect(args.mobileSpeculative).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Re-download the model to enable the MTP drafter",
        ),
      );
    } finally {
      warnSpy.mockRestore();
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
