/**
 * Test helper re-exporting the screenshot-quality classifier plus
 * assertScreenshotBase64NotBlank, so real-driver screenshot lanes can assert a
 * capture is not blank.
 */
import { expect } from "vitest";

export {
  analyzePngScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "../../src/platform/screenshot-quality.ts";

import {
  analyzePngScreenshot,
  screenshotQualityIssues,
} from "../../src/platform/screenshot-quality.ts";

export function assertScreenshotBase64NotBlank(
  screenshot: string | undefined,
  label: string,
  minBytes = 100,
): void {
  expect(screenshot, `${label}: screenshot base64 should exist`).toBeTruthy();
  const buffer = Buffer.from(screenshot ?? "", "base64");
  expect(buffer.length, `${label}: decoded PNG byte length`).toBeGreaterThan(
    minBytes,
  );
  const quality = analyzePngScreenshot(buffer);
  expect(
    screenshotQualityIssues(label, quality),
    `${label}: screenshot quality ${JSON.stringify(quality)}`,
  ).toEqual([]);
}
