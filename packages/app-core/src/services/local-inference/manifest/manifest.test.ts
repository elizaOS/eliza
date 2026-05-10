import { describe, expect, it } from "vitest";
import {
  canSetAsDefault,
  ELIZA_1_MANIFEST_SCHEMA_VERSION,
  REQUIRED_KERNELS_BY_TIER,
  validateManifest,
} from "./index";
import type { Eliza1DeviceCaps, Eliza1Manifest, Eliza1Tier } from "./types";

const SHA = "0".repeat(64);

function passingBackends() {
  return {
    metal: { status: "pass" as const, atCommit: "abc1234", report: "metal.txt" },
    vulkan: { status: "pass" as const, atCommit: "abc1234", report: "vulkan.txt" },
    cuda: { status: "pass" as const, atCommit: "abc1234", report: "cuda.txt" },
    cpu: { status: "pass" as const, atCommit: "abc1234", report: "cpu.txt" },
  };
}

function baseManifest(tier: Eliza1Tier = "desktop-9b"): Eliza1Manifest {
  return {
    id: `eliza-1-${tier}`,
    tier,
    version: "1.0.0",
    publishedAt: "2026-05-10T00:00:00Z",
    lineage: {
      text: { base: "eliza-1-text-backbone", license: "apache-2.0" },
      voice: { base: "eliza-1-voice-backbone", license: "apache-2.0" },
      drafter: { base: "eliza-1-drafter", license: "apache-2.0" },
    },
    files: {
      text: [{ path: `text/eliza-1-${tier}-64k.gguf`, ctx: 65536, sha256: SHA }],
      voice: [{ path: "tts/omnivoice-1.7b.gguf", sha256: SHA }],
      asr: [{ path: "asr/asr.gguf", sha256: SHA }],
      vision: [{ path: `vision/mmproj-${tier}.gguf`, sha256: SHA }],
      dflash: [{ path: `dflash/drafter-${tier}.gguf`, sha256: SHA }],
      cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA }],
    },
    kernels: {
      required: [...REQUIRED_KERNELS_BY_TIER[tier]],
      optional: ["turbo3_tcq"],
      verifiedBackends: passingBackends(),
    },
    evals: {
      textEval: { score: 0.71, passed: true },
      voiceRtf: { rtf: 0.42, passed: true },
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
});

describe("validateManifest — valid input", () => {
  it("accepts a fully-populated, default-eligible manifest", () => {
    const result = validateManifest(baseManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.tier).toBe("desktop-9b");
      expect(result.manifest.defaultEligible).toBe(true);
    }
  });

  it("accepts every tier with that tier's required kernel set", () => {
    for (const tier of ["lite-0_6b", "mobile-1_7b", "desktop-9b", "pro-27b", "server-h200"] as const) {
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
    const m = baseManifest("desktop-9b");
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
      expect(
        result.errors.some((e) => e.includes("textEval")),
      ).toBe(true);
      expect(
        result.errors.some((e) => e.includes("defaultEligible")),
      ).toBe(true);
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

  it("rejects defaultEligible=true when a supported backend did not pass", () => {
    const m = baseManifest("desktop-9b");
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

  it("does not require cuda for tiers that don't ship on cuda", () => {
    const m = baseManifest("lite-0_6b");
    // lite tier doesn't ship on cuda; cuda fail should not block.
    m.kernels.verifiedBackends.cuda = {
      status: "fail",
      atCommit: "abc1234",
      report: "cuda.txt",
    };
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  it("requires turbo3_tcq when text ctx > 64k", () => {
    const m = baseManifest("desktop-9b");
    m.files.text[0].ctx = 131072;
    m.kernels.optional = []; // remove turbo3_tcq
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("turbo3_tcq"))).toBe(true);
    }
  });

  it("accepts turbo3_tcq in required when ctx > 64k", () => {
    const m = baseManifest("desktop-9b");
    m.files.text[0].ctx = 131072;
    m.kernels.required = [...m.kernels.required, "turbo3_tcq"];
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
    expect(canSetAsDefault(baseManifest("desktop-9b"), device)).toBe(true);
  });

  it("returns false when the manifest's defaultEligible is false", () => {
    const m = baseManifest("desktop-9b");
    m.defaultEligible = false;
    expect(canSetAsDefault(m, device)).toBe(false);
  });

  it("returns false when device RAM is below the manifest minimum", () => {
    const m = baseManifest("desktop-9b");
    expect(canSetAsDefault(m, { ...device, ramMb: 4_000 })).toBe(false);
  });

  it("returns false when the device shares no passing backend with the tier", () => {
    const m = baseManifest("server-h200"); // server tier supports cuda/vulkan/cpu
    // device only has metal — overlap with server tier is none, except cpu.
    // server tier *does* support cpu, so this passes; tighten to just an
    // unrelated backend to verify the exclusion path.
    expect(canSetAsDefault(m, { availableBackends: ["metal"], ramMb: 64_000 })).toBe(
      false,
    );
  });

  it("returns false when the manifest fails contract checks even if defaultEligible=true", () => {
    const m = baseManifest("desktop-9b");
    m.kernels.required = ["turboquant_q4"]; // missing qjl/polarquant/dflash
    expect(canSetAsDefault(m, device)).toBe(false);
  });
});
