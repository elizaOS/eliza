/**
 * Deterministic unit coverage for the visual readiness comparison used by the
 * real iOS Simulator walkthrough recorder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { normalizedImageDifference } from "./lib/device-image.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

async function solidImage(root, name, color) {
  const output = path.join(root, name);
  await sharp({
    create: { width: 64, height: 128, channels: 3, background: color },
  })
    .png()
    .toFile(output);
  return output;
}

describe("device image readiness comparison", () => {
  it("accepts the same loaded frame and separates a black boot frame", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "device-image-test-"));
    roots.push(root);
    const loaded = await solidImage(root, "loaded.png", {
      r: 120,
      g: 45,
      b: 20,
    });
    const same = await solidImage(root, "same.png", {
      r: 120,
      g: 45,
      b: 20,
    });
    const boot = await solidImage(root, "boot.png", { r: 0, g: 0, b: 0 });

    expect(await normalizedImageDifference(loaded, same)).toBe(0);
    expect(await normalizedImageDifference(loaded, boot)).toBeGreaterThan(0.2);
  });
});
