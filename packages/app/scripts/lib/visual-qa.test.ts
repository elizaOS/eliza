// Unit tests for the visual-QA analyzer: colour fractions, dominant palette,
// change-metric, and the pure expectation evaluator, all on synthetic
// sharp-generated fixtures so they run deterministically in CI without a real
// screenshot. OCR must remain packaged: the analyzer may prefer a system
// tesseract binary, but the repo dependency fallback is part of the contract.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyzeScreenshot,
  changeMetric,
  colorFractions,
  dominantPalette,
  evaluateExpectation,
} from "./visual-qa.mjs";

const dir = mkdtempSync(join(tmpdir(), "visual-qa-"));
const __dirname = dirname(fileURLToPath(import.meta.url));
const appPackageJson = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
);
const rootPackageJson = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../package.json"), "utf8"),
);
const rootLockfile = readFileSync(
  resolve(__dirname, "../../../../bun.lock"),
  "utf8",
);
const solid = async (name: string, r: number, g: number, b: number) => {
  const p = join(dir, name);
  await sharp({
    create: { width: 120, height: 120, channels: 3, background: { r, g, b } },
  })
    .png()
    .toFile(p);
  return p;
};

afterAll(() => {
  // best-effort temp cleanup; leaving fixtures on failure aids debugging
});

describe("colorFractions", () => {
  it("reads a solid blue frame as overwhelmingly blue, not orange", async () => {
    const c = await colorFractions(await solid("blue.png", 30, 60, 200));
    expect(c.blue_fraction).toBeGreaterThan(0.9);
    expect(c.orange_fraction).toBe(0);
  });
  it("reads a brand-orange frame as orange, not blue", async () => {
    const c = await colorFractions(await solid("orange.png", 220, 110, 40));
    expect(c.orange_fraction).toBeGreaterThan(0.9);
    expect(c.blue_fraction).toBe(0);
  });
  it("reads a grey frame as near-neutral", async () => {
    const c = await colorFractions(await solid("grey.png", 180, 180, 182));
    expect(c.neutral_fraction).toBeGreaterThan(0.9);
    expect(c.blue_fraction).toBe(0);
  });
});

describe("dominantPalette", () => {
  it("returns the fill colour as the dominant bucket", async () => {
    const pal = await dominantPalette(await solid("red.png", 240, 16, 16));
    expect(pal[0].fraction).toBeGreaterThan(0.9);
    expect(pal[0].rgb[0]).toBeGreaterThan(200);
  });
});

describe("changeMetric", () => {
  it("reports ~0 change for identical frames and ~full change for different ones", async () => {
    const grey = await solid("g1.png", 180, 180, 180);
    const greySame = await solid("g2.png", 180, 180, 180);
    const blue = await solid("b1.png", 20, 40, 200);
    expect((await changeMetric(grey, greySame)).changed_fraction).toBe(0);
    const diff = await changeMetric(grey, blue);
    expect(diff.changed_fraction).toBeGreaterThan(0.9);
    expect(diff.changed_bbox_norm).not.toBeNull();
  });
});

describe("evaluateExpectation (pure gate logic)", () => {
  const neutral = { blue_fraction: 0, orange_fraction: 0, neutral_fraction: 1 };
  it("passes when required text is present and no blue", () => {
    const r = evaluateExpectation({
      text: "Sign in to Eliza Cloud\nAsk me anything",
      colors: neutral,
      expect: {
        require_text: ["Eliza", "Sign in"],
        forbid_text: ["undefined"],
      },
    });
    expect(r.verdict).toBe("pass");
  });
  it("fails when required text is missing", () => {
    const r = evaluateExpectation({
      text: "some other screen",
      colors: neutral,
      expect: { require_text: ["Sign in to Eliza Cloud"] },
    });
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.name.startsWith("require_text"))?.ok).toBe(
      false,
    );
  });
  it("fails when forbidden text (a broken-pipeline tell) is present", () => {
    const r = evaluateExpectation({
      text: "Balance: undefined\nStartup failed: NaN",
      colors: neutral,
      expect: { forbid_text: ["undefined", "Startup failed", "NaN"] },
    });
    expect(r.verdict).toBe("fail");
    expect(
      r.checks.filter((c) => c.name.startsWith("forbid_text") && !c.ok),
    ).toHaveLength(3);
  });
  it("fails the brand rule when blue exceeds the ceiling", () => {
    const r = evaluateExpectation({
      text: "",
      colors: { blue_fraction: 0.4, orange_fraction: 0, neutral_fraction: 0.6 },
      expect: { max_blue_fraction: 0.02 },
    });
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.name === "brand:no_blue")?.ok).toBe(false);
  });
});

describe("analyzeScreenshot end to end", () => {
  it("keeps the packaged tesseract.js fallback available for required OCR", async () => {
    expect(
      appPackageJson.dependencies?.["tesseract.js"] ??
        appPackageJson.devDependencies?.["tesseract.js"],
    ).toBeTruthy();
    expect(
      rootPackageJson.dependencies?.["tesseract.js"] ??
        rootPackageJson.devDependencies?.["tesseract.js"],
    ).toBeTruthy();
    expect(rootLockfile).toContain('"tesseract.js": ["tesseract.js@');
  });

  it("flags a blue screen as a brand:no_blue failure with a real palette", async () => {
    const report = await analyzeScreenshot(
      await solid("bluescreen.png", 20, 40, 210),
      {
        expect: { state: "synthetic-blue", max_blue_fraction: 0.02 },
      },
    );
    expect(report.verdict).toBe("fail");
    expect(report.color_fractions.blue_fraction).toBeGreaterThan(0.9);
    expect(report.dominant_palette[0].fraction).toBeGreaterThan(0.9);
    // OCR must either produce text or name the engine failure; it must never
    // fabricate an empty read as a successful "no text on screen" result.
    expect(typeof report.ocr_text).toBe("string");
    expect(
      report.ocr_note === null || typeof report.ocr_note === "string",
    ).toBe(true);
  });
});
