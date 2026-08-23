/**
 * Tests for the inline per-GPU profile registry in gpu-tier-profiles.
 *
 * Harness is deterministic: the real module is driven directly — the
 * registry data, selection, and argv builder are all documented as pure,
 * bundled constants with no fs, network, or model-file access.
 */
import { describe, expect, it } from "vitest";

import {
  buildLlamaCppArgs,
  GPU_PROFILES,
  getGpuProfile,
  selectBestProfile,
} from "../gpu-tier-profiles.js";

// ---------------------------------------------------------------------------
// 1. GPU_PROFILES — registry shape and integrity
// ---------------------------------------------------------------------------

describe("GPU_PROFILES", () => {
  it("contains exactly the four supported built-in ids", () => {
    expect(Object.keys(GPU_PROFILES).sort()).toEqual([
      "h200",
      "rtx-3090",
      "rtx-4090",
      "rtx-5090",
    ]);
  });

  it("keys every entry by its own canonical id", () => {
    for (const [key, profile] of Object.entries(GPU_PROFILES)) {
      expect(profile.id).toBe(key);
    }
  });

  it("only carries sane hardware numbers on every profile", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      expect(profile.vram_gb).toBeGreaterThan(0);
      expect(profile.display_name.length).toBeGreaterThan(0);
      expect(profile.notes.length).toBeGreaterThan(0);
      expect(profile.features.length).toBeGreaterThan(0);
      expect(profile.ctx_size_tokens).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. getGpuProfile — hit and miss branches
// ---------------------------------------------------------------------------

describe("getGpuProfile", () => {
  it("returns the registry entry itself for every built-in id", () => {
    for (const [key, profile] of Object.entries(GPU_PROFILES)) {
      expect(getGpuProfile(key)).toBe(profile);
    }
  });

  it("returns null for an unrecognised id", () => {
    expect(getGpuProfile("rtx-totally-fake")).toBeNull();
  });

  it("returns null for an empty id", () => {
    expect(getGpuProfile("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. selectBestProfile — eligibility, ordering, ties, empty result
// ---------------------------------------------------------------------------

describe("selectBestProfile", () => {
  it("qualifies a card at the exact VRAM and compute boundaries", () => {
    // 24 GB / sm_8.6 host: only the 3090 satisfies both limits exactly.
    expect(selectBestProfile(24, "8.6")?.id).toBe("rtx-3090");
  });

  it("returns null when the detected VRAM sits below every supported card", () => {
    expect(selectBestProfile(8, "8.6")).toBeNull();
  });

  it("picks the highest-VRAM card that fits", () => {
    expect(selectBestProfile(32, "12.0")?.id).toBe("rtx-5090");
  });

  it("excludes cards whose compute capability exceeds the host even when VRAM fits", () => {
    // 141 GB host at sm_8.9: H200 needs 9.0 and 5090 needs 12.0, so the
    // best remaining 24 GB card wins despite the huge VRAM budget.
    expect(selectBestProfile(141, "8.9")?.id).toBe("rtx-4090");
  });

  it("breaks a VRAM tie by the higher compute-capability card", () => {
    // Both 3090 and 4090 are 24 GB; a sm_8.9 host admits both.
    expect(selectBestProfile(24, "8.9")?.id).toBe("rtx-4090");
  });

  it("still returns the largest fitting card when the host exceeds every compute cap", () => {
    expect(selectBestProfile(256, "10.0")?.id).toBe("h200");
  });

  it("admits a card whose compute equals the host capability exactly", () => {
    expect(selectBestProfile(141, "9.0")?.id).toBe("h200");
  });

  it("accepts the underscore compute spelling as a dotted version", () => {
    expect(selectBestProfile(24, "8_9")?.id).toBe("rtx-4090");
  });

  it("returns null when the compute string cannot be parsed", () => {
    expect(selectBestProfile(141, "not-a-number")).toBeNull();
  });

  it("returns null for an empty compute string", () => {
    expect(selectBestProfile(141, "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. buildLlamaCppArgs — flag order, conditional flags, overrides
// ---------------------------------------------------------------------------

describe("buildLlamaCppArgs", () => {
  it("emits the documented flag order for a mmap+non-NUMA card", () => {
    const rtx3090 = getGpuProfile("rtx-3090");
    if (!rtx3090) throw new Error("expected rtx-3090 profile");
    expect(buildLlamaCppArgs(rtx3090)).toEqual([
      "--n-gpu-layers",
      "99",
      "--flash-attn",
      "--ctx-size",
      "32768",
    ]);
  });

  it("appends --no-mmap before --numa for the H200 defaults", () => {
    const h200 = getGpuProfile("h200");
    if (!h200) throw new Error("expected h200 profile");
    expect(buildLlamaCppArgs(h200)).toEqual([
      "--n-gpu-layers",
      "99",
      "--flash-attn",
      "--no-mmap",
      "--numa",
      "--ctx-size",
      "262144",
    ]);
  });

  it("drops --flash-attn when overridden to false", () => {
    const rtx3090 = getGpuProfile("rtx-3090");
    if (!rtx3090) throw new Error("expected rtx-3090 profile");
    expect(buildLlamaCppArgs(rtx3090, { flash_attn: false })).toEqual([
      "--n-gpu-layers",
      "99",
      "--ctx-size",
      "32768",
    ]);
  });

  it("drops --no-mmap when use_mmap is overridden to true while keeping --numa", () => {
    const h200 = getGpuProfile("h200");
    if (!h200) throw new Error("expected h200 profile");
    expect(buildLlamaCppArgs(h200, { use_mmap: true })).toEqual([
      "--n-gpu-layers",
      "99",
      "--flash-attn",
      "--numa",
      "--ctx-size",
      "262144",
    ]);
  });

  it("honours a ctx_size_tokens override without mutating the shared profile", () => {
    const rtx3090 = getGpuProfile("rtx-3090");
    if (!rtx3090) throw new Error("expected rtx-3090 profile");
    const argv = buildLlamaCppArgs(rtx3090, { ctx_size_tokens: 8192 });
    expect(argv.at(-1)).toBe("8192");
    expect(argv.includes("--ctx-size")).toBe(true);
    expect(rtx3090.ctx_size_tokens).toBe(32768);
  });

  it("never references a model file for any built-in profile", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      expect(buildLlamaCppArgs(profile)).not.toContain("--model");
    }
  });
});
