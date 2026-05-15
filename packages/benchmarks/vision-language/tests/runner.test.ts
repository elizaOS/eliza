import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runOneBenchmark, lookupBaseline } from "../src/runner.ts";
import { createStubRuntime } from "../src/runtime-resolver.ts";

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
    expect(report.benchmark).toBe("textvqa");
    expect(report.sample_count).toBe(5);
    expect(report.samples).toHaveLength(5);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(1);
    expect(report.error_count).toBe(0);
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

describe("lookupBaseline", () => {
  it("returns the registered Qwen2.5-VL baseline for a known (tier, benchmark) pair", () => {
    const baseline = lookupBaseline("eliza-1-9b", "screenspot");
    expect(baseline).not.toBeNull();
    expect(baseline?.score).toBeCloseTo(0.876);
    expect(baseline?.source).toMatch(/Qwen/);
  });

  it("returns null for an unregistered pair", () => {
    expect(lookupBaseline("eliza-1-0_8b", "screenspot")).toBeNull();
  });
});
