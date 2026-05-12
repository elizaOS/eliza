import { describe, expect, it } from "vitest";
import { REQUIRED_KERNELS_BY_TIER, validateManifest } from "./index";
import type { Eliza1Manifest, Eliza1Tier } from "./types";

const SHA = "0".repeat(64);

function passingBackends() {
  return {
    metal: {
      status: "pass" as const,
      atCommit: "abc1234",
      report: "metal.txt",
    },
    vulkan: {
      status: "pass" as const,
      atCommit: "abc1234",
      report: "vulkan.txt",
    },
    cuda: { status: "pass" as const, atCommit: "abc1234", report: "cuda.txt" },
    rocm: { status: "pass" as const, atCommit: "abc1234", report: "rocm.txt" },
    cpu: { status: "pass" as const, atCommit: "abc1234", report: "cpu.txt" },
  };
}

function baseManifest(tier: Eliza1Tier = "9b"): Eliza1Manifest {
  return {
    id: `eliza-1-${tier}`,
    tier,
    version: "1.0.0",
    publishedAt: "2026-05-11T00:00:00Z",
    lineage: {
      text: { base: "eliza-1-text-backbone", license: "apache-2.0" },
      voice: { base: "eliza-1-voice-backbone", license: "apache-2.0" },
      drafter: { base: "eliza-1-drafter", license: "apache-2.0" },
      asr: { base: "eliza-1-asr", license: "apache-2.0" },
      vision: { base: "eliza-1-vision", license: "apache-2.0" },
      vad: { base: "eliza-1-vad", license: "apache-2.0" },
    },
    files: {
      text: [
        { path: `text/eliza-1-${tier}-64k.gguf`, ctx: 65536, sha256: SHA },
      ],
      voice: [{ path: "tts/omnivoice-base-Q4_K_M.gguf", sha256: SHA }],
      asr: [{ path: "asr/asr.gguf", sha256: SHA }],
      vision: [{ path: `vision/mmproj-${tier}.gguf`, sha256: SHA }],
      dflash: [{ path: `dflash/drafter-${tier}.gguf`, sha256: SHA }],
      cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA }],
      vad: [{ path: "vad/silero-vad-v5.1.2.ggml.bin", sha256: SHA }],
    },
    kernels: {
      required: [...REQUIRED_KERNELS_BY_TIER[tier]],
      optional: [],
      verifiedBackends: passingBackends(),
    },
    evals: {
      textEval: { score: 0.71, passed: true },
      voiceRtf: { rtf: 0.42, passed: true },
      asrWer: { wer: 0.05, passed: true },
      vadLatencyMs: {
        median: 16,
        boundaryMs: 24,
        endpointMs: 80,
        falseBargeInRate: 0.01,
        passed: true,
      },
      dflash: { acceptanceRate: 0.72, speedup: 1.8, passed: true },
      e2eLoopOk: true,
      thirtyTurnOk: true,
    },
    ramBudgetMb: { min: 7000, recommended: 9500 },
    defaultEligible: true,
  };
}

describe("manifest evals — dflash bench slot", () => {
  it("accepts a non-default manifest with no dflash eval", () => {
    const m = baseManifest();
    m.defaultEligible = false;
    delete m.evals.dflash;
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  it("accepts a non-default needs-hardware dflash eval", () => {
    const m = baseManifest();
    m.defaultEligible = false;
    m.evals = {
      ...m.evals,
      dflash: { acceptanceRate: null, speedup: null, passed: false },
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.evals.dflash).toEqual({
        acceptanceRate: null,
        speedup: null,
        passed: false,
      });
    }
  });

  it("accepts a measured dflash eval that passed", () => {
    const m = baseManifest();
    m.evals = {
      ...m.evals,
      dflash: { acceptanceRate: 0.72, speedup: 1.8, passed: true },
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  it("rejects defaultEligible when the dflash eval is missing", () => {
    const m = baseManifest();
    delete m.evals.dflash;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes("evals.dflash: required")),
      ).toBe(true);
    }
  });

  it("rejects passed=true with null numbers (a needs-hardware bench cannot pass)", () => {
    const m = baseManifest();
    m.evals = {
      ...m.evals,
      dflash: { acceptanceRate: null, speedup: 1.8, passed: true },
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("evals.dflash"))).toBe(true);
    }
  });

  it("rejects an out-of-range acceptanceRate", () => {
    const m = baseManifest() as unknown as Record<string, unknown>;
    (m.evals as Record<string, unknown>).dflash = {
      acceptanceRate: 1.5,
      speedup: 1.8,
      passed: false,
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects a negative speedup", () => {
    const m = baseManifest() as unknown as Record<string, unknown>;
    (m.evals as Record<string, unknown>).dflash = {
      acceptanceRate: 0.7,
      speedup: -1,
      passed: false,
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects defaultEligible when the dflash eval did not pass", () => {
    const m = baseManifest();
    m.evals = {
      ...m.evals,
      dflash: { acceptanceRate: 0.4, speedup: 1.1, passed: false },
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("evals.dflash.passed"))).toBe(
        true,
      );
    }
  });
});
