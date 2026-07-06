// Diff analyzers on synthetic before/after pairs. diff.change: identical → 0,
// different → high. diff.region: a known changed rectangle clusters to one box
// whose normalized position is within tolerance of where it was drawn, and the
// per-region expectations (change / static) evaluate to the right pass/fail.
// Baseline is supplied via a caller ctx.baselineResolver — no hardcoded dir.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  changeMetric,
  clusterRegions,
  diffChangeAnalyzer,
  diffRegionAnalyzer,
  evaluateRegionExpectations,
} from "./diff.ts";
import { makeTmpDir, rectPng, solidPng } from "./test-fixtures.ts";
import type { AnalyzerContext, AnalyzerInput } from "./types.ts";

const dir = makeTmpDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const inputFor = (
  absolutePath: string,
  path = "visual/x/after.png",
): AnalyzerInput => ({
  entry: {
    path,
    sha256: "0".repeat(64),
    bytes: 0,
    kind: "screenshot",
    source: "test",
    producedBy: "test",
    createdAt: new Date().toISOString(),
  },
  absolutePath,
});

describe("changeMetric (ported)", () => {
  it("reports 0 for identical frames and high for different", async () => {
    const a = await solidPng(join(dir, "c-a.png"), [180, 180, 180]);
    const aSame = await solidPng(join(dir, "c-a2.png"), [180, 180, 180]);
    const b = await solidPng(join(dir, "c-b.png"), [20, 40, 200]);
    expect((await changeMetric(a, aSame)).changed_fraction).toBe(0);
    expect((await changeMetric(a, b)).changed_fraction).toBeGreaterThan(0.9);
  });
});

describe("clusterRegions (pure)", () => {
  it("clusters a contiguous changed block into a single box", () => {
    const w = 32;
    const h = 32;
    const mask = new Uint8Array(w * h);
    // Fill a 8x8 block at (8,8).
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) mask[y * w + x] = 1;
    }
    const regions = clusterRegions(mask, w, h, 32);
    expect(regions).toHaveLength(1);
    expect(regions[0].x).toBeGreaterThanOrEqual(0.2);
    expect(regions[0].x).toBeLessThanOrEqual(0.3);
  });
});

describe("diffRegionAnalyzer", () => {
  const base: [number, number, number] = [240, 240, 240];
  const size = 240;
  // A red rectangle occupying the middle band, drawn only in "after".
  const rect = { left: 60, top: 90, width: 120, height: 60 };

  const buildPair = async () => {
    const before = await solidPng(join(dir, "before.png"), base, size, size);
    const after = await rectPng(
      join(dir, "after.png"),
      base,
      rect,
      [220, 20, 20],
      size,
      size,
    );
    return { before, after };
  };

  it("finds the changed rectangle as a region within tolerance", async () => {
    const { before, after } = await buildPair();
    const ctx: AnalyzerContext = {
      tier: "cpu",
      baselineResolver: () => before,
    };
    const result = await diffRegionAnalyzer.analyze(inputFor(after), ctx);
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as {
      changed_fraction: number;
      regions: { x: number; y: number; w: number; h: number }[];
    };
    expect(data.changed_fraction).toBeGreaterThan(0);
    expect(data.regions.length).toBeGreaterThanOrEqual(1);
    const top = data.regions[0];
    // Expected normalized box ≈ x 0.25, y 0.375, w 0.5, h 0.25. Coarse grid so
    // allow generous tolerance.
    expect(top.x).toBeGreaterThanOrEqual(0.15);
    expect(top.x).toBeLessThanOrEqual(0.35);
    expect(top.y).toBeGreaterThanOrEqual(0.28);
    expect(top.y).toBeLessThanOrEqual(0.48);
    expect(top.w).toBeGreaterThan(0.3);
  });

  it("passes a change-expected region and a static-expected region correctly", async () => {
    const { before, after } = await buildPair();
    const ctx: AnalyzerContext = {
      tier: "cpu",
      baselineResolver: () => before,
      expectations: {
        "visual/x/after.png": {
          regions: [
            // The rect band is expected to change.
            {
              kind: "change",
              label: "banner",
              region: { x: 0.2, y: 0.35, w: 0.6, h: 0.3 },
            },
            // The top strip is expected to stay static.
            {
              kind: "static",
              label: "header",
              region: { x: 0, y: 0, w: 1, h: 0.2 },
            },
          ],
        },
      },
    };
    const result = await diffRegionAnalyzer.analyze(inputFor(after), ctx);
    if (result.status !== "ran") throw new Error("expected ran");
    const data = result.data as {
      assertions: { label: string; ok: boolean }[];
    };
    const byLabel = Object.fromEntries(
      data.assertions.map((a) => [a.label, a.ok]),
    );
    expect(byLabel.banner).toBe(true);
    expect(byLabel.header).toBe(true);
  });

  it("fails a static-expected region that actually changed", async () => {
    const { before, after } = await buildPair();
    const ctx: AnalyzerContext = {
      tier: "cpu",
      baselineResolver: () => before,
      expectations: {
        "visual/x/after.png": {
          regions: [
            {
              kind: "static",
              label: "should-not-move",
              region: { x: 0.2, y: 0.35, w: 0.6, h: 0.3 },
            },
          ],
        },
      },
    };
    const result = await diffRegionAnalyzer.analyze(inputFor(after), ctx);
    if (result.status !== "ran") throw new Error("expected ran");
    const data = result.data as { assertions: { ok: boolean }[] };
    expect(data.assertions[0].ok).toBe(false);
  });

  it("skips honestly when no baseline resolves", async () => {
    const after = await rectPng(
      join(dir, "nobaseline.png"),
      base,
      rect,
      [220, 20, 20],
      size,
      size,
    );
    const ctx: AnalyzerContext = { tier: "cpu", baselineResolver: () => null };
    const result = await diffRegionAnalyzer.analyze(inputFor(after), ctx);
    expect(result.status).toBe("skipped-missing-tool");
  });

  it("skips honestly when no baselineResolver is provided at all", async () => {
    const after = await rectPng(
      join(dir, "noresolver.png"),
      base,
      rect,
      [220, 20, 20],
      size,
      size,
    );
    const result = await diffChangeAnalyzer.analyze(inputFor(after), {
      tier: "cpu",
    });
    expect(result.status).toBe("skipped-missing-tool");
  });

  it("rejects malformed region expectations instead of sampling garbage", () => {
    const mask = new Uint8Array(16);
    const bad = [
      { x: 0.5, y: 0, w: 0.8, h: 0.5 }, // x+w > 1
      { x: -0.1, y: 0, w: 0.5, h: 0.5 }, // negative origin
      { x: 0, y: 0, w: 0, h: 0.5 }, // degenerate width
      { x: 0, y: 0, w: Number.NaN, h: 0.5 }, // non-finite
    ];
    for (const region of bad) {
      expect(() =>
        evaluateRegionExpectations(mask, 4, 4, [
          { kind: "change", label: "typo", region },
        ]),
      ).toThrow(/invalid normalized box/);
    }
    // A valid box still evaluates.
    expect(
      evaluateRegionExpectations(mask, 4, 4, [
        { kind: "static", region: { x: 0, y: 0, w: 1, h: 1 } },
      ]),
    ).toHaveLength(1);
  });

  it("fails the analyzer (never a wrong pass) on an out-of-range expectation", async () => {
    const before = await solidPng(join(dir, "exp-a.png"), [30, 30, 30], 64, 64);
    const after = await solidPng(join(dir, "exp-b.png"), [30, 30, 30], 64, 64);
    const ctx: AnalyzerContext = {
      tier: "cpu",
      baselineResolver: () => before,
      expectations: {
        "visual/x/after.png": {
          regions: [
            { kind: "change", region: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } },
          ],
        },
      },
    };
    await expect(
      diffRegionAnalyzer.analyze(inputFor(after), ctx),
    ).rejects.toThrow(/invalid normalized box/);
  });
});
