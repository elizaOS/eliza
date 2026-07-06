// brand.rules on synthetic frames: a blue frame fails no_blue, a heavily-orange
// frame fails orange_is_accent, and a neutral frame passes. Pure threshold logic
// is exercised via evaluateBrand; the analyzer is exercised end to end on a
// sharp-generated blue frame.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { brandRulesAnalyzer, evaluateBrand } from "./brand.ts";
import { makeTmpDir, solidPng } from "./test-fixtures.ts";
import type { AnalyzerContext } from "./types.ts";

const dir = makeTmpDir();
const ctx: AnalyzerContext = { tier: "cpu" };
const inputFor = (absolutePath: string) => ({
  entry: {
    path: "visual/x/img.png",
    sha256: "0".repeat(64),
    bytes: 0,
    kind: "screenshot" as const,
    source: "test",
    producedBy: "test",
    createdAt: new Date().toISOString(),
  },
  absolutePath,
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("evaluateBrand (pure)", () => {
  it("passes a neutral frame", () => {
    const r = evaluateBrand({
      blue_fraction: 0,
      orange_fraction: 0.1,
      neutral_fraction: 0.9,
    });
    expect(r.verdict).toBe("pass");
  });
  it("fails when blue exceeds the ceiling", () => {
    const r = evaluateBrand({
      blue_fraction: 0.4,
      orange_fraction: 0,
      neutral_fraction: 0.6,
    });
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.name === "no_blue")?.ok).toBe(false);
  });
  it("fails when orange reads as fill, not accent", () => {
    const r = evaluateBrand({
      blue_fraction: 0,
      orange_fraction: 0.9,
      neutral_fraction: 0.1,
    });
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.name === "orange_is_accent")?.ok).toBe(false);
  });
});

describe("brandRulesAnalyzer", () => {
  it("fails a solid blue screen", async () => {
    const p = await solidPng(join(dir, "blue.png"), [20, 40, 210]);
    const result = await brandRulesAnalyzer.analyze(inputFor(p), ctx);
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as {
      verdict: string;
      blue_fraction: number;
    };
    expect(data.verdict).toBe("fail");
    expect(data.blue_fraction).toBeGreaterThan(0.9);
  });
});
