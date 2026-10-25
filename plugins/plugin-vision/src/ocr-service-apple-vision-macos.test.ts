/**
 * Real-engine coverage for the macOS Apple Vision OCR provider (#9105 — per-OS
 * native OCR fallback).
 *
 * Drives the bundled Swift helper (`native/macos-vision-ocr.swift`) over the
 * checked-in screenshot fixture (real antialiased glyphs: "Eliza OCR" /
 * "Submit 4200") and asserts the provider returns the recognized text plus
 * positive-area, top-left pixel bounding boxes — the display-absolute
 * convention shared with the other OCR providers.
 *
 * Gated on darwin (`process.platform === "darwin"`): VNRecognizeTextRequest
 * only exists on Apple platforms, so this runs on macOS and skips cleanly on
 * Linux/Windows CI, keeping the default `vitest run` green everywhere.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  __test__,
  createMacosVisionOcrProvider,
  isMacosVisionOcrAvailable,
} from "./ocr-service-apple-vision-macos";

const isDarwin = process.platform === "darwin";

const fixturePng = readFileSync(
  fileURLToPath(
    new URL("../test/fixtures/ocr-real-sample.png", import.meta.url),
  ),
);

describe("macOS Apple Vision OCR provider availability preflight", () => {
  const env = {
    ELIZA_MACOS_VISION_OCR_SCRIPT: "/mock/macos-vision-ocr.swift",
    PATH: "/mock/bin",
  } satisfies NodeJS.ProcessEnv;

  it("requires darwin before advertising Apple Vision", () => {
    expect(
      __test__.macosVisionAvailable({
        platform: "linux",
        env,
        pathExists: () => true,
        executableExists: () => true,
      }),
    ).toBe(false);
  });

  it("requires the Swift helper script before advertising Apple Vision", () => {
    expect(
      __test__.macosVisionAvailable({
        platform: "darwin",
        env,
        pathExists: () => false,
        executableExists: () => true,
      }),
    ).toBe(false);
  });

  it("requires a swift executable before advertising Apple Vision", () => {
    expect(
      __test__.macosVisionAvailable({
        platform: "darwin",
        env,
        pathExists: () => true,
        executableExists: (name) => name === "python",
      }),
    ).toBe(false);
  });

  it("reports available when darwin, the helper, and swift are present", () => {
    expect(
      __test__.macosVisionAvailable({
        platform: "darwin",
        env,
        pathExists: () => true,
        executableExists: (name) => name === "swift",
      }),
    ).toBe(true);
  });

  it("honors ELIZA_DISABLE_APPLE_VISION even when preflights pass", () => {
    expect(
      __test__.macosVisionAvailable({
        platform: "darwin",
        env: { ...env, ELIZA_DISABLE_APPLE_VISION: "1" },
        pathExists: () => true,
        executableExists: () => true,
      }),
    ).toBe(false);
  });
});

describe.skipIf(!isDarwin)(
  "macOS Apple Vision OCR provider — real VNRecognizeText over a real screenshot",
  () => {
    it("reports available on darwin with the bundled swift helper present", () => {
      expect(isMacosVisionOcrAvailable()).toBe(true);
      const provider = createMacosVisionOcrProvider();
      expect(provider.name).toBe("macos-apple-vision");
      expect(provider.available()).toBe(true);
    });

    it("recognizes the rendered words with positive-area pixel boxes", async () => {
      const provider = createMacosVisionOcrProvider();
      const result = await provider.recognize({
        kind: "bytes",
        data: new Uint8Array(fixturePng),
      });

      // The fixture renders "Eliza OCR" + "Submit 4200".
      expect(result.fullText).toMatch(/Eliza/i);
      expect(result.fullText).toMatch(/4200/);
      expect(result.lines.length).toBeGreaterThan(0);

      // At least one line carries a real, positive-area top-left pixel box that
      // fits inside the 800×240 fixture.
      const withArea = result.lines.filter(
        (line) => line.boundingBox.width > 0 && line.boundingBox.height > 0,
      );
      expect(withArea.length).toBeGreaterThan(0);
      for (const line of withArea) {
        expect(line.text.length).toBeGreaterThan(0);
        expect(line.confidence).toBeGreaterThan(0);
        expect(line.boundingBox.x).toBeGreaterThanOrEqual(0);
        expect(line.boundingBox.y).toBeGreaterThanOrEqual(0);
        expect(line.boundingBox.x + line.boundingBox.width).toBeLessThanOrEqual(
          800,
        );
        expect(
          line.boundingBox.y + line.boundingBox.height,
        ).toBeLessThanOrEqual(240);
      }
    });

    it("returns an empty result for empty input without spawning swift", async () => {
      const provider = createMacosVisionOcrProvider();
      const result = await provider.recognize({
        kind: "bytes",
        data: new Uint8Array(0),
      });
      expect(result.lines).toEqual([]);
      expect(result.fullText).toBe("");
    });
  },
);
