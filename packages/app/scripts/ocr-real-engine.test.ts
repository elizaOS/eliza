/**
 * Exercises packaged Tesseract and pixel diagnostics against a real launcher capture plus adversarial generated frames.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  evaluateOcrContent,
  type OcrResult,
} from "../test/ui-smoke/ocr-content-rules";
import {
  closeOcrEngines,
  ocrImage,
  resetTesseractProbe,
} from "./mvp-visual-verify/ocr.mjs";
import { runOcrTriage } from "./ocr-triage";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_CAPTURE = resolve(
  HERE,
  "mvp-visual-verify/baseline/mobile-portrait/builtin-rolodex.png",
);
const dir = mkdtempSync(join(tmpdir(), "ocr-real-engine-"));
const previousEngine = process.env.ELIZA_MVP_OCR_ENGINE;

function contentResult(
  result: Awaited<ReturnType<typeof ocrImage>>,
): OcrResult {
  if (!result.available) {
    return {
      ok: false,
      text: "",
      lines: [],
      words: 0,
      meanConfidence: 0,
      reason: result.reason,
    };
  }
  return {
    ok: true,
    text: result.text,
    lines: result.text.split("\n").filter(Boolean),
    words: result.words,
    meanConfidence: result.meanConfidence,
    pixelBlank: result.pixelBlank,
    pixelBlankReasons: result.pixelBlankReasons,
    selectedMode: result.selectedMode,
    attempts: result.attempts,
  };
}

beforeAll(() => {
  process.env.ELIZA_MVP_OCR_ENGINE = "packaged";
  resetTesseractProbe();
});

afterAll(async () => {
  await closeOcrEngines();
  resetTesseractProbe();
  if (previousEngine === undefined) delete process.env.ELIZA_MVP_OCR_ENGINE;
  else process.env.ELIZA_MVP_OCR_ENGINE = previousEngine;
  rmSync(dir, { recursive: true, force: true });
});

describe("real OCR blank-vs-unreadable classification", () => {
  it("does not call a populated mobile launcher blank when the first OCR pass is weak", async () => {
    const auditDir = join(dir, "launcher-audit");
    const viewportDir = join(auditDir, "mobile-portrait");
    mkdirSync(viewportDir, { recursive: true });
    copyFileSync(LAUNCHER_CAPTURE, join(viewportDir, "builtin-rolodex.png"));
    writeFileSync(
      join(auditDir, "report.json"),
      JSON.stringify([
        {
          slug: "builtin-rolodex",
          viewport: "mobile-portrait",
          viewType: "gui",
          verdict: "good",
        },
      ]),
    );

    const triage = await runOcrTriage([
      "--audit-dir",
      auditDir,
      "--out",
      join(auditDir, "ocr-triage.json"),
    ]);
    const entry = triage.entries[0];
    if (!entry) throw new Error("expected launcher triage entry");
    const attempts = entry.attempts;
    if (!attempts) throw new Error("expected retained OCR attempts");

    expect(attempts[0]).toMatchObject({
      mode: "auto",
      ok: true,
    });
    expect(attempts[0].meanConfidence).toBeLessThan(0.45);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({
      mode: "sparse-high-contrast",
      ok: true,
    });
    expect(entry.selectedMode).toBe("sparse-high-contrast");
    expect(entry.text).toMatch(/Ask Eliza/i);
    expect(entry.pixelBlank).toBe(false);
    expect(entry.ocrVerdict).toBe("needs-eyeball");
    expect(entry.regression).toBe(false);
    expect(entry.reasons.join(" ")).not.toMatch(/pixels are blank/i);
  }, 90_000);

  it("still breaks a genuinely solid frame after both real OCR passes", async () => {
    const path = join(dir, "solid.png");
    await sharp({
      create: {
        width: 390,
        height: 844,
        channels: 4,
        background: { r: 208, g: 216, b: 216, alpha: 1 },
      },
    })
      .png()
      .toFile(path);

    const result = await ocrImage(path, { timeoutMs: 60_000 });
    if (!result.available) throw new Error(result.reason);
    expect(result.pixelBlank).toBe(true);

    const finding = evaluateOcrContent({ ocr: contentResult(result) });
    expect(finding.blankPixels).toBe(true);
    expect(finding.ocrInconclusive).toBe(false);
    expect(finding.verdict).toBe("broken");
    expect(finding.reasons.join(" ")).toMatch(/one color/);
  }, 90_000);

  it("routes a nonblank textless gradient to review instead of fabricating blank pixels", async () => {
    const width = 390;
    const height = 844;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = 72 + Math.floor((156 * x) / (width - 1));
        const offset = (y * width + x) * 3;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
      }
    }
    const path = join(dir, "gradient.png");
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(path);

    const result = await ocrImage(path, { timeoutMs: 60_000 });
    if (!result.available) throw new Error(result.reason);
    expect(result.pixelBlank).toBe(false);

    const finding = evaluateOcrContent({ ocr: contentResult(result) });
    expect(finding.blankPixels).toBe(false);
    expect(finding.ocrInconclusive).toBe(true);
    expect(finding.verdict).toBe("needs-eyeball");
    expect(finding.reasons.join(" ")).toMatch(/OCR inconclusive/);
  }, 90_000);

  it("keeps near-solid quality warnings distinct from proof of a blank frame", async () => {
    const width = 120;
    const height = 120;
    const pixels = Buffer.alloc(width * height * 3, 255);
    pixels[0] = 16;
    pixels[1] = 16;
    pixels[2] = 16;
    const path = join(dir, "near-solid.png");
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(path);

    const result = await ocrImage(path, { timeoutMs: 60_000 });
    if (!result.available) throw new Error(result.reason);
    expect(result.imageAnalysis.issues).toContain(
      "screenshot is effectively one color",
    );
    expect(result.imageAnalysis.issues).toContain(
      "screenshot is near-solid black/white",
    );
    expect(result.pixelBlank).toBe(false);

    const finding = evaluateOcrContent({ ocr: contentResult(result) });
    expect(finding.blankPixels).toBe(false);
    expect(finding.verdict).toBe("needs-eyeball");
  }, 90_000);
});
