import {
  GPU_PROFILE_IDS,
  GPU_PROFILES,
  matchGpuProfile,
  reservedHeadroomGb,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { applyGpuProfile } from "./dflash-server";
import { recommendProfileFromName } from "./gpu-detect";

describe("GPU profiles", () => {
  it("exposes one entry for every supported card", () => {
    expect(GPU_PROFILE_IDS).toEqual([
      "rtx-3090",
      "rtx-4090",
      "rtx-5090",
      "h200",
    ]);
    for (const id of GPU_PROFILE_IDS) {
      expect(GPU_PROFILES[id]).toBeDefined();
      expect(GPU_PROFILES[id].id).toBe(id);
    }
  });

  it("H200 ships the 1M-context bundle as its first recommendation", () => {
    const h200 = GPU_PROFILES.h200;
    expect(h200.recommendedBundles[0]).toBe("eliza-1-27b-1m");
    expect(h200.contextSize).toBe(1_048_576);
    expect(h200.kvCacheTypeK).toBe("qjl1_256");
    expect(h200.kvCacheTypeV).toBe("q4_polar");
    expect(h200.vramGb).toBeGreaterThanOrEqual(140);
    expect(h200.kvSpillToCpu).toBe(false);
  });

  it("consumer 24 GB cards leave headroom and prefer mid-tier bundles", () => {
    const a3090 = GPU_PROFILES["rtx-3090"];
    const a4090 = GPU_PROFILES["rtx-4090"];
    expect(a3090.vramGb).toBe(24);
    expect(a4090.vramGb).toBe(24);
    expect(a3090.recommendedBundles[0]).toBe("eliza-1-9b");
    expect(a4090.recommendedBundles).toContain("eliza-1-27b");
    expect(reservedHeadroomGb(a3090)).toBeGreaterThan(0);
    expect(reservedHeadroomGb(a4090)).toBeGreaterThan(0);
  });

  it("matches GPU names case-insensitively", () => {
    expect(matchGpuProfile("NVIDIA H200")).toBe("h200");
    expect(matchGpuProfile("nvidia rtx 5090")).toBe("rtx-5090");
    expect(matchGpuProfile("NVIDIA GeForce RTX 4090")).toBe("rtx-4090");
    expect(matchGpuProfile("NVIDIA GeForce RTX 3090 Ti")).toBe("rtx-3090");
    expect(matchGpuProfile("Tesla A100")).toBeNull();
    expect(matchGpuProfile("Quadro RTX 8000")).toBeNull();
  });

  it("recommendProfileFromName is a stable alias for matchGpuProfile", () => {
    expect(recommendProfileFromName("NVIDIA H200")).toBe("h200");
    expect(recommendProfileFromName("AMD Radeon RX 7900")).toBeNull();
  });
});

describe("applyGpuProfile", () => {
  it("injects KV cache, parallel, batch, draft, and mlock flags", () => {
    const args: string[] = ["llama-server"];
    applyGpuProfile(args, GPU_PROFILES.h200);
    expect(args).toContain("--cache-type-k");
    expect(args).toContain("qjl1_256");
    expect(args).toContain("--cache-type-v");
    expect(args).toContain("q4_polar");
    expect(args).toContain("--parallel");
    expect(args).toContain("16");
    expect(args).toContain("--batch-size");
    expect(args).toContain("4096");
    expect(args).toContain("--ubatch-size");
    expect(args).toContain("2048");
    expect(args).toContain("--mlock");
    expect(args).toContain("-fa");
    expect(args).toContain("--draft-min");
    expect(args).toContain("--draft-max");
    expect(args).toContain("32");
  });

  it("does not push duplicates when the flag is already present", () => {
    const args: string[] = [
      "--cache-type-k",
      "f16",
      "--batch-size",
      "1024",
      "--mlock",
    ];
    applyGpuProfile(args, GPU_PROFILES["rtx-4090"]);
    expect(args.filter((a) => a === "--cache-type-k").length).toBe(1);
    expect(args.filter((a) => a === "--batch-size").length).toBe(1);
    expect(args.filter((a) => a === "--mlock").length).toBe(1);
    // Pre-set values survive.
    const k = args[args.indexOf("--cache-type-k") + 1];
    const b = args[args.indexOf("--batch-size") + 1];
    expect(k).toBe("f16");
    expect(b).toBe("1024");
  });

  it("never injects --n-gpu-layers or --ctx-size (owned by the spawn site)", () => {
    const args: string[] = [];
    applyGpuProfile(args, GPU_PROFILES["rtx-5090"]);
    expect(args).not.toContain("--n-gpu-layers");
    expect(args).not.toContain("--ctx-size");
  });

  it("emits --no-kv-offload only when kvSpillToCpu is true", () => {
    const args: string[] = [];
    applyGpuProfile(args, GPU_PROFILES.h200);
    expect(args).not.toContain("--no-kv-offload");
  });
});
