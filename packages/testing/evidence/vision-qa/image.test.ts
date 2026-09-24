/**
 * Downscale-math and image-prep tests. `scaleToMaxEdge` is pure and covers the
 * boundary conditions (no upscale, both orientations, exact-cap). `prepareImage`
 * runs against real PNGs written by sharp so the base64/dimension/hash outputs
 * are the real thing, and asserts a typed failure on unreadable/undecodable
 * input rather than a blank-image request.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceError } from "../errors.ts";
import { DEFAULT_MAX_EDGE, prepareImage, scaleToMaxEdge } from "./image.ts";

describe("scaleToMaxEdge", () => {
  it("never upscales an already-small image", () => {
    expect(scaleToMaxEdge(800, 600, 1568)).toEqual({ width: 800, height: 600 });
  });

  it("caps a wide image's longest edge and preserves aspect", () => {
    expect(scaleToMaxEdge(2000, 1000, 1568)).toEqual({
      width: 1568,
      height: 784,
    });
  });

  it("caps a tall image's longest edge", () => {
    expect(scaleToMaxEdge(1000, 3136, 1568)).toEqual({
      width: 500,
      height: 1568,
    });
  });

  it("leaves an image exactly at the cap unchanged", () => {
    expect(scaleToMaxEdge(1568, 900, 1568)).toEqual({
      width: 1568,
      height: 900,
    });
  });
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-img-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prepareImage", () => {
  it("downscales a large PNG and records both dimensions plus the source hash", async () => {
    const file = path.join(dir, "big.png");
    await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: "#f0781e" },
    })
      .png()
      .toFile(file);
    const prepared = await prepareImage(file);
    expect(prepared.mediaType).toBe("image/png");
    expect(prepared.dimensions).toEqual({
      originalWidth: 3000,
      originalHeight: 1500,
      sentWidth: DEFAULT_MAX_EDGE,
      sentHeight: DEFAULT_MAX_EDGE / 2,
    });
    expect(prepared.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.base64.length).toBeGreaterThan(0);
    // The base64 must decode to a valid, downscaled PNG.
    const meta = await sharp(Buffer.from(prepared.base64, "base64")).metadata();
    expect(meta.width).toBe(DEFAULT_MAX_EDGE);
  });

  it("leaves a small image at its native size", async () => {
    const file = path.join(dir, "small.png");
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#111" },
    })
      .png()
      .toFile(file);
    const prepared = await prepareImage(file);
    expect(prepared.dimensions.sentWidth).toBe(400);
    expect(prepared.dimensions.sentHeight).toBe(300);
  });

  it("throws typed on a missing file", async () => {
    await expect(
      prepareImage(path.join(dir, "nope.png")),
    ).rejects.toMatchObject({ code: "VISION_IMAGE_UNREADABLE" });
  });

  it("throws typed on a non-image file", async () => {
    const file = path.join(dir, "notimage.png");
    fs.writeFileSync(file, "this is plain text, not a PNG");
    await expect(prepareImage(file)).rejects.toBeInstanceOf(EvidenceError);
  });
});
