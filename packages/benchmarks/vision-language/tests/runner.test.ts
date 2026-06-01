import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandSamples,
  lookupBaseline,
  runOneBenchmark,
  scenarioCounts,
  validateSamples,
} from "../src/runner.ts";
import { createStubRuntime, resolveRuntime } from "../src/runtime-resolver.ts";

describe("runOneBenchmark", () => {
  it("runs the textvqa smoke fixture end-to-end against the stub runtime", async () => {
    const runtime = createStubRuntime("test");
    const report = await runOneBenchmark({
      tier: "stub",
      benchmark: "textvqa",
      samples: 5,
      smoke: true,
      runtime,
    });
    expect(report.schemaVersion).toBe("vision-language-bench-v1");
    expect(report.runtime_id).toBe("test-stub");
    expect(report.smoke).toBe(true);
    expect(report.benchmark).toBe("textvqa");
    expect(report.sample_count).toBe(5);
    expect(report.samples).toHaveLength(5);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(1);
    expect(report.error_count).toBe(0);
  });

  it("expands selected samples into ten edge variants each", async () => {
    const runtime = createStubRuntime("test");
    const report = await runOneBenchmark({
      tier: "stub",
      benchmark: "textvqa",
      samples: 1,
      smoke: true,
      runtime,
      expandScenarios: true,
      validateScenarios: true,
    });

    expect(report.include_edge_scenarios).toBe(true);
    expect(report.scenario_counts).toEqual({ base: 1, edge: 10, total: 11 });
    expect(report.sample_count).toBe(11);
    expect(report.samples[1].sampleId).toMatch(/__edge_01$/);
  });

  it("counts and validates expanded sample ids", () => {
    const samples = [
      {
        id: "sample-a",
        imagePath: "samples/_placeholder.png",
        question: "What text is visible?",
        payload: { answers: ["ok"] },
      },
    ];

    const expanded = expandSamples(samples, true);

    expect(scenarioCounts(samples.length, true)).toEqual({
      base: 1,
      edge: 10,
      total: 11,
    });
    expect(expanded).toHaveLength(11);
    expect(expanded[1].id).toBe("sample-a__edge_01");
    expect(validateSamples(samples, true).valid).toBe(true);
  });

  it("aggregates runtime token telemetry into the report", async () => {
    const report = await runOneBenchmark({
      tier: "stub",
      benchmark: "textvqa",
      samples: 2,
      smoke: true,
      runtime: {
        id: "usage-runtime",
        async ask() {
          return "unknown";
        },
        usage() {
          return {
            input_tokens: 100,
            output_tokens: 20,
            cached_tokens: 25,
            cache_creation_tokens: 5,
            llm_call_count: 2,
          };
        },
      },
    });

    expect(report.input_tokens).toBe(100);
    expect(report.output_tokens).toBe(20);
    expect(report.total_tokens).toBe(120);
    expect(report.cached_tokens).toBe(25);
    expect(report.cache_creation_tokens).toBe(5);
    expect(report.cached_token_percent).toBe(25);
    expect(report.llm_call_count).toBe(2);
  });

  it("runs the screenspot smoke fixture and returns a non-zero score for centred clicks", async () => {
    const runtime = createStubRuntime("test");
    const report = await runOneBenchmark({
      tier: "stub",
      benchmark: "screenspot",
      samples: 5,
      smoke: true,
      runtime,
    });
    expect(report.sample_count).toBe(5);
    // The stub clicks at (640, 400). Smoke fixture #2 (login username field
    // bbox 400..880 x 320..360) contains that point — so we expect at
    // least one hit.
    expect(report.score).toBeGreaterThan(0);
  });

  it("runs the osworld smoke fixture without invoking the VM", async () => {
    const runtime = createStubRuntime("test");
    const report = await runOneBenchmark({
      tier: "stub",
      benchmark: "osworld",
      samples: 5,
      smoke: true,
      runtime,
    });
    expect(report.sample_count).toBe(5);
    expect(report.error_count).toBe(0);
  });

  it("writes a standalone report when called via the public API and the caller saves it", async () => {
    const runtime = createStubRuntime("test");
    const report = await runOneBenchmark({
      tier: "stub",
      benchmark: "docvqa",
      samples: 5,
      smoke: true,
      runtime,
    });
    const dir = mkdtempSync(join(tmpdir(), "vlb-"));
    const target = join(dir, "report.json");
    const fs = await import("node:fs");
    fs.writeFileSync(target, JSON.stringify(report, null, 2));
    expect(existsSync(target)).toBe(true);
    const round = JSON.parse(readFileSync(target, "utf8"));
    expect(round.benchmark).toBe("docvqa");
    expect(Array.isArray(round.samples)).toBe(true);
  });
});

describe("resolveRuntime", () => {
  it("fails closed instead of falling back to stub for full runs", async () => {
    await expect(
      resolveRuntime({ tier: "missing-real-tier", forceStub: false }),
    ).rejects.toThrow(/no real IMAGE_DESCRIPTION runtime available/);
  });

  it("still allows explicit stub smoke runtime", async () => {
    const runtime = await resolveRuntime({
      tier: "missing-real-tier",
      forceStub: true,
    });
    expect(runtime.id).toBe("missing-real-tier-stub");
  });

  it("requires an explicit multimodal model for Hermes/OpenClaw runtimes", async () => {
    await expect(
      resolveRuntime({
        tier: "eliza-1-9b",
        forceStub: false,
        harness: "hermes",
      }),
    ).rejects.toThrow(/requires --model or VISION_LANGUAGE_MODEL/);
  });

  it("uses the same explicit-model guard for ElizaOS/OpenCode vision runtimes", async () => {
    await expect(
      resolveRuntime({
        tier: "eliza-1-9b",
        forceStub: false,
        harness: "opencode",
      }),
    ).rejects.toThrow(/requires --model or VISION_LANGUAGE_MODEL/);

    await expect(
      resolveRuntime({
        tier: "eliza-1-9b",
        forceStub: false,
        harness: "elizaos",
      }),
    ).rejects.toThrow(/requires --model or VISION_LANGUAGE_MODEL/);
  });
});

describe("lookupBaseline", () => {
  it("returns the registered Qwen2.5-VL baseline for a known (tier, benchmark) pair", () => {
    const baseline = lookupBaseline("eliza-1-9b", "screenspot");
    expect(baseline !== null).toBe(true);
    expect(baseline?.score).toBeCloseTo(0.876);
    expect(baseline?.source).toMatch(/Qwen/);
  });

  it("returns null for an unregistered pair", () => {
    expect(lookupBaseline("eliza-1-0_8b", "screenspot")).toBeNull();
  });
});
