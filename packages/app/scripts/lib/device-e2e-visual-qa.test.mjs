/**
 * Covers the bundle visual-QA pass: an injected deterministic analyzer verifies
 * the walk/sidecar/aggregate schema, and one case drives the REAL
 * `analyzeScreenshot` (via `visual-qa.mjs`) against a `sharp`-generated solid
 * PNG fixture to prove the actual consumption works headlessly.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { attachVisualQa, listScreenshots } from "./device-e2e-visual-qa.mjs";

function tmpBundle() {
  return mkdtempSync(path.join(tmpdir(), "vqa-bundle-"));
}

async function solidPng(outPath, { r, g, b }) {
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r, g, b } },
  })
    .png()
    .toFile(outPath);
  return outPath;
}

describe("listScreenshots", () => {
  it("returns only image files, sorted, excluding sidecars", async () => {
    const dir = tmpBundle();
    await solidPng(path.join(dir, "b.png"), { r: 10, g: 10, b: 10 });
    await solidPng(path.join(dir, "a.png"), { r: 20, g: 20, b: 20 });
    // a stray sidecar + a non-image must be ignored
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "a.png.visual-qa.json"), "{}");
    writeFileSync(path.join(dir, "notes.txt"), "x");
    const shots = listScreenshots(dir).map((p) => path.basename(p));
    expect(shots).toEqual(["a.png", "b.png"]);
  });
});

describe("attachVisualQa — injected analyzer (schema)", () => {
  it("writes a sidecar per image and a root aggregate with verdict roll-up", async () => {
    const dir = tmpBundle();
    const screenshots = path.join(dir, "inline");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(screenshots, { recursive: true });
    await solidPng(path.join(screenshots, "home.png"), { r: 0, g: 0, b: 0 });
    await solidPng(path.join(screenshots, "chat.png"), { r: 0, g: 0, b: 0 });

    const fakeReports = {
      "home.png": { image: "home.png", verdict: "pass", state: "home" },
      "chat.png": { image: "chat.png", verdict: "fail", state: "chat" },
    };
    const aggregate = await attachVisualQa({
      bundleDir: dir,
      screenshotsDir: screenshots,
      expectations: { "home.png": { state: "home" } },
      analyze: async (img) => fakeReports[path.basename(img)],
    });

    expect(aggregate.total).toBe(2);
    expect(aggregate.passed).toBe(1);
    expect(aggregate.failed).toBe(1);
    expect(aggregate.reports).toEqual([
      {
        image: "chat.png",
        sidecar: "inline/chat.png.visual-qa.json",
        verdict: "fail",
        state: "chat",
      },
      {
        image: "home.png",
        sidecar: "inline/home.png.visual-qa.json",
        verdict: "pass",
        state: "home",
      },
    ]);

    // sidecars written beside the pixels
    const homeSidecar = JSON.parse(
      readFileSync(path.join(screenshots, "home.png.visual-qa.json"), "utf8"),
    );
    expect(homeSidecar.verdict).toBe("pass");
    // root aggregate written
    expect(existsSync(path.join(dir, "visual-qa.json"))).toBe(true);
  });

  it("passes the per-image expectation spec through to the analyzer", async () => {
    const dir = tmpBundle();
    await solidPng(path.join(dir, "shot.png"), { r: 0, g: 0, b: 0 });
    let seenExpect = null;
    await attachVisualQa({
      bundleDir: dir,
      screenshotsDir: dir,
      expectations: {
        "shot.png": { require_text: ["Welcome"], max_blue_fraction: 0.01 },
      },
      analyze: async (_img, { expect: e }) => {
        seenExpect = e;
        return { verdict: "pass" };
      },
    });
    expect(seenExpect).toEqual({
      require_text: ["Welcome"],
      max_blue_fraction: 0.01,
    });
  });
});

describe("attachVisualQa — REAL analyzeScreenshot", () => {
  it("produces an OCR/palette/verdict report for a real PNG fixture", async () => {
    const dir = tmpBundle();
    // A near-neutral dark grey screenshot: no blue → brand rule passes.
    await solidPng(path.join(dir, "neutral.png"), { r: 24, g: 24, b: 24 });
    const aggregate = await attachVisualQa({
      bundleDir: dir,
      screenshotsDir: dir,
    });
    expect(aggregate.total).toBe(1);
    const report = JSON.parse(
      readFileSync(path.join(dir, "neutral.png.visual-qa.json"), "utf8"),
    );
    // Real analyzer fields present.
    expect(report.size).toEqual([64, 64]);
    expect(Array.isArray(report.dominant_palette)).toBe(true);
    expect(report.color_fractions).toHaveProperty("blue_fraction");
    expect(report.color_fractions.blue_fraction).toBe(0);
    expect(report.verdict).toBe("pass");
  });
});
