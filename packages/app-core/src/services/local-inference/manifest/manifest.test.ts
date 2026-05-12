import { describe, expect, it } from "vitest";
import {
  ELIZA_1_TIERS,
  ELIZA_1_TOKENIZER_FAMILY,
  canSetAsDefault,
  ELIZA_1_MANIFEST_SCHEMA_VERSION,
  REQUIRED_KERNELS_BY_TIER,
  validateManifest,
} from "./index";
import type { Eliza1DeviceCaps, Eliza1Manifest, Eliza1Tier } from "./types";

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
    publishedAt: "2026-05-10T00:00:00Z",
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

describe("Eliza-1 manifest schema constants", () => {
  it("exports schema version 1", () => {
    expect(ELIZA_1_MANIFEST_SCHEMA_VERSION).toBe("1");
  });

  it("uses Qwen3.5 small-tier ids and tokenizer family", () => {
    expect(ELIZA_1_TOKENIZER_FAMILY).toBe("qwen35");
    expect(ELIZA_1_TIERS.slice(0, 3)).toEqual(["0_8b", "2b", "4b"]);
    expect(Object.keys(REQUIRED_KERNELS_BY_TIER)).toEqual(
      expect.arrayContaining(["0_8b", "2b"]),
    );
    expect(Object.keys(REQUIRED_KERNELS_BY_TIER)).not.toEqual(
      expect.arrayContaining(["0_8b", "2b"]),
    );
  });
});

describe("validateManifest — valid input", () => {
  it("accepts a fully-populated, default-eligible manifest", () => {
    const result = validateManifest(baseManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.tier).toBe("9b");
      expect(result.manifest.defaultEligible).toBe(true);
      expect(result.manifest.evals.vadLatencyMs?.falseBargeInRate).toBe(0.01);
    }
  });

  it("keeps legacy ONNX VAD manifests compatible", () => {
    const m = baseManifest();
    m.files.vad = [{ path: "vad/silero-vad-int8.onnx", sha256: SHA }];
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  it("accepts optional component lineage, files, evals, and voice capabilities", () => {
    const m = baseManifest();
    m.lineage.embedding = { base: "eliza-1-embedding", license: "apache-2.0" };
    m.lineage.wakeword = { base: "eliza-1-wakeword", license: "apache-2.0" };
    m.files.embedding = [{ path: "embedding/eliza-1-embed.gguf", sha256: SHA }];
    m.files.wakeword = [{ path: "wakeword/eliza-1.onnx", sha256: SHA }];
    m.voice = {
      version: "1",
      frozen: true,
      cache: {
        speakerPreset: "cache/voice-preset-default.bin",
        phraseCacheSeed: "cache/voice-preset-default.bin",
      },
      capabilities: ["tts", "emotion-tags"],
    };
    m.evals.embedMteb = { score: 0.62, passed: true };
    m.evals.expressive = {
      tagFaithfulness: 0.9,
      mosExpressive: 4.1,
      tagLeakage: 0.01,
      passed: true,
    };

    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  it("accepts every tier with that tier's required kernel set", () => {
    for (const tier of ELIZA_1_TIERS) {
      const m = baseManifest(tier);
      const result = validateManifest(m);
      const detail = result.ok ? "" : ` errors=${result.errors.join(", ")}`;
      expect(result.ok, `${tier} should validate.${detail}`).toBe(true);
    }
  });
});

describe("validateManifest — schema-level rejections", () => {
  it("rejects a manifest with a bad sha256", () => {
    const m = baseManifest();
    m.files.text[0].sha256 = "not-a-hash";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range VAD false barge-in metrics", () => {
    const m = baseManifest();
    m.evals.vadLatencyMs = {
      median: 16,
      falseBargeInRate: 1.2,
      passed: true,
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown tier", () => {
    const m = baseManifest() as unknown as Record<string, unknown>;
    m.tier = "ultra-99b";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects bad semver", () => {
    const m = baseManifest();
    (m as Record<string, unknown>).version = "v1";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects publishedAt with a timezone offset (Zod parity with Python)", () => {
    // The Python validator's _DATETIME_RE matches Zod's `.datetime()`
    // default — only `Z` suffix is accepted, no offsets. Keeping the
    // two sides in lockstep prevents drift between training-side
    // build_manifest output and runtime-side validation.
    const m = baseManifest();
    m.publishedAt = "2026-05-10T00:00:00+00:00";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects an id that does not encode the tier", () => {
    const m = baseManifest();
    m.id = "eliza-1-foo";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });
});

describe("validateManifest — contract rejections", () => {
  it("rejects a manifest missing a required kernel for its tier", () => {
    const m = baseManifest("9b");
    m.kernels.required = ["turboquant_q4", "qjl", "polarquant"]; // missing dflash
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("dflash"))).toBe(true);
    }
  });

  it("rejects defaultEligible=true when textEval did not pass", () => {
    const m = baseManifest();
    m.evals.textEval.passed = false;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("textEval"))).toBe(true);
      expect(result.errors.some((e) => e.includes("defaultEligible"))).toBe(
        true,
      );
    }
  });

  it("rejects defaultEligible=true when voiceRtf did not pass", () => {
    const m = baseManifest();
    m.evals.voiceRtf.passed = false;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects defaultEligible=true when e2eLoopOk is false", () => {
    const m = baseManifest();
    m.evals.e2eLoopOk = false;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects component files without matching lineage and eval gates", () => {
    const m = baseManifest();
    m.lineage.asr = undefined;
    m.evals.asrWer = undefined;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("lineage.asr"))).toBe(true);
      expect(result.errors.some((e) => e.includes("evals.asrWer"))).toBe(true);
    }
  });

  it("rejects defaultEligible=true when ASR or VAD are absent", () => {
    const m = baseManifest();
    m.files.asr = [];
    m.files.vad = [];
    m.lineage.asr = undefined;
    m.lineage.vad = undefined;
    m.evals.asrWer = undefined;
    m.evals.vadLatencyMs = undefined;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("files.asr"))).toBe(true);
      expect(result.errors.some((e) => e.includes("files.vad"))).toBe(true);
    }
  });

  it("rejects expressive voice capabilities without expressive eval", () => {
    const m = baseManifest();
    m.voice = {
      version: "1",
      frozen: true,
      cache: {
        speakerPreset: "cache/voice-preset-default.bin",
        phraseCacheSeed: "cache/voice-preset-default.bin",
      },
      capabilities: ["tts", "singing"],
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("evals.expressive"))).toBe(
        true,
      );
    }
  });

  it("rejects defaultEligible=true when a supported backend did not pass", () => {
    const m = baseManifest("9b");
    m.kernels.verifiedBackends.cuda = {
      status: "fail",
      atCommit: "abc1234",
      report: "cuda.txt",
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("cuda"))).toBe(true);
    }
  });

  it("does not require cuda or rocm for tiers that don't ship on cuda/rocm", () => {
    const m = baseManifest("0_8b");
    // 0.8B tier doesn't ship on cuda/rocm; failures there should not block.
    m.kernels.verifiedBackends.cuda = {
      status: "fail",
      atCommit: "abc1234",
      report: "cuda.txt",
    };
    m.kernels.verifiedBackends.rocm = {
      status: "fail",
      atCommit: "abc1234",
      report: "rocm.txt",
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  it("requires rocm for desktop and server tiers", () => {
    const m = baseManifest("9b");
    m.kernels.verifiedBackends.rocm = {
      status: "fail",
      atCommit: "abc1234",
      report: "rocm.txt",
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("rocm"))).toBe(true);
    }
  });

  it("requires turbo3_tcq when text ctx > 64k", () => {
    const m = baseManifest("9b");
    m.files.text[0].ctx = 131072;
    m.kernels.required = m.kernels.required.filter((k) => k !== "turbo3_tcq");
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("turbo3_tcq"))).toBe(true);
    }
  });

  it("rejects turbo3_tcq as optional-only when ctx > 64k", () => {
    const m = baseManifest("9b");
    m.files.text[0].ctx = 131072;
    m.kernels.required = m.kernels.required.filter((k) => k !== "turbo3_tcq");
    m.kernels.optional = ["turbo3_tcq"];
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("kernels.required"))).toBe(
        true,
      );
    }
  });

  it("accepts turbo3_tcq in required when ctx > 64k", () => {
    const m = baseManifest("9b");
    m.files.text[0].ctx = 131072;
    m.kernels.optional = [];
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });
});

describe("canSetAsDefault", () => {
  const device: Eliza1DeviceCaps = {
    availableBackends: ["metal", "cpu"],
    ramMb: 32_000,
  };

  it("returns true for a default-eligible bundle on a supported backend", () => {
    expect(canSetAsDefault(baseManifest("9b"), device)).toBe(true);
  });

  it("returns false when the manifest's defaultEligible is false", () => {
    const m = baseManifest("9b");
    m.defaultEligible = false;
    expect(canSetAsDefault(m, device)).toBe(false);
  });

  it("returns false when device RAM is below the manifest minimum", () => {
    const m = baseManifest("9b");
    expect(canSetAsDefault(m, { ...device, ramMb: 4_000 })).toBe(false);
  });

  it("returns false when the device shares no passing backend with the tier", () => {
    const m = baseManifest("27b-256k");
    m.kernels.verifiedBackends.metal = {
      status: "fail",
      atCommit: "abc1234",
      report: "metal.txt",
    };
    expect(
      canSetAsDefault(m, { availableBackends: ["metal"], ramMb: 64_000 }),
    ).toBe(false);
  });

  it("returns false when the manifest fails contract checks even if defaultEligible=true", () => {
    const m = baseManifest("9b");
    m.kernels.required = ["turboquant_q4"]; // missing qjl/polarquant/dflash
    expect(canSetAsDefault(m, device)).toBe(false);
  });
});
