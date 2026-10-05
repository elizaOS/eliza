/**
 * Shared synthetic-fixture helpers for the analyzer tests. Everything is
 * generated in-test with sharp (solid fills, gradients, text-SVG renders, and
 * before/after pairs with a known changed rectangle) so the suite is
 * deterministic and needs no checked-in binary fixtures. Import path is
 * `.ts`-explicit to match the package's bundler module resolution.
 *
 * NOT a test file itself (no `.test.ts`), so vitest does not collect it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/** Make a throwaway temp dir; caller removes it (or leaves it for debugging). */
export function makeTmpDir(prefix = "evidence-analyzers-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a solid RGB PNG of the given size. */
export async function solidPng(
  filePath: string,
  rgb: [number, number, number],
  width = 120,
  height = 120,
): Promise<string> {
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .png()
    .toFile(filePath);
  return filePath;
}

/**
 * Write a PNG that is `base` everywhere except a filled rectangle of `rectColor`
 * at `rect` (absolute pixel coordinates). Used to build a before/after pair with
 * a known changed region for the region-diff test.
 */
export async function rectPng(
  filePath: string,
  base: [number, number, number],
  rect: { left: number; top: number; width: number; height: number },
  rectColor: [number, number, number],
  width = 240,
  height = 240,
): Promise<string> {
  const overlay = await sharp({
    create: {
      width: rect.width,
      height: rect.height,
      channels: 3,
      background: { r: rectColor[0], g: rectColor[1], b: rectColor[2] },
    },
  })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: base[0], g: base[1], b: base[2] },
    },
  })
    .composite([{ input: overlay, left: rect.left, top: rect.top }])
    .png()
    .toFile(filePath);
  return filePath;
}

/** Render text on a white background via an SVG, for OCR fixtures. */
export async function textPng(
  filePath: string,
  text: string,
  width = 640,
  height = 160,
): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="white"/>
    <text x="20" y="100" font-family="Helvetica, Arial, sans-serif" font-size="64" fill="black">${text}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
  return filePath;
}

/** A left-to-right grayscale gradient PNG, for palette/phash variety. */
export async function gradientPng(
  filePath: string,
  width = 128,
  height = 128,
): Promise<string> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255);
      const i = (y * width + x) * 3;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
  return filePath;
}
