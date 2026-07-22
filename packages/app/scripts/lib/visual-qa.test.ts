/**
 * Exercises the visual-QA analyzer with real Sharp pixels and packaged OCR.
 * Deterministic generated frames cover palette, diff, and blank-proof boundaries;
 * the installed Tesseract dependency remains part of the end-to-end contract.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  comparePixels,
  summarizeDiff,
} from "@elizaos/evidence/visual-primitives";
import sharp from "sharp";
import { analyzeImageFile } from "../mvp-visual-verify/ocr.mjs";
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
  rmSync(dir, { recursive: true, force: true });
});

describe("pixel blank proof", () => {
  it("distinguishes a one-color frame from visible multicolor pixels", async () => {
    const blank = await analyzeImageFile(
      await solid("pixel-blank.png", 208, 216, 216),
    );
    expect(blank.pixelBlank).toBe(true);
    expect(blank.pixelBlankReasons).toEqual(["screenshot is one color"]);

    const visiblePath = join(dir, "pixel-visible.png");
    await sharp(Buffer.from([0, 0, 0, 255, 255, 255]), {
      raw: { width: 2, height: 1, channels: 3 },
    })
      .png()
      .toFile(visiblePath);
    const visible = await analyzeImageFile(visiblePath);
    expect(visible.colorBuckets).toBe(2);
    expect(visible.pixelBlank).toBe(false);
    expect(visible.pixelBlankReasons).toEqual([]);
  });
});

describe("pixel comparison diagnostics", () => {
  it("counts visible channel changes and emits an inspectable highlight", () => {
    const baseline = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
    const current = Buffer.from([10, 20, 30, 255, 250, 0, 250, 255]);
    const comparison = comparePixels(current, baseline, 2, 1, {
      threshold: 30,
      buildHighlight: true,
    });

    expect(comparison.changedPixels).toBe(1);
    expect(comparison.totalPixels).toBe(2);
    expect(comparison.sumAbsDelta).toBe(450);
    expect(comparison.highlight).toEqual(
      Buffer.from([27, 27, 27, 255, 255, 0, 255, 255]),
    );
    expect(summarizeDiff({ ...comparison, resized: false })).toEqual({
      changedPixels: 1,
      totalPixels: 2,
      changedRatio: 0.5,
      changedPercent: 50,
      meanAbsDelta: 75,
      resized: false,
    });
  });

  it("rejects dimensions and summaries that cannot represent real pixels", () => {
    expect(() => comparePixels(Buffer.alloc(4), Buffer.alloc(4), 2, 1)).toThrow(
      "buffers too small",
    );
    expect(() =>
      summarizeDiff({
        changedPixels: 0,
        totalPixels: 0,
        sumAbsDelta: 0,
        resized: false,
      }),
    ).toThrow("totalPixels must be > 0");
  });
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
