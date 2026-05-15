#!/usr/bin/env node
/**
 * Generate the three deterministic PNG fixtures consumed by the
 * vision-CUA E2E harness.
 *
 *   - fixtures/single-1920x1080/display-1/{frame,frame-after}.png
 *   - fixtures/ultra-wide-5120x1440/display-1/{frame,frame-after}.png
 *   - fixtures/multi-display-composite/display-1/{frame,frame-after}.png
 *   - fixtures/multi-display-composite/display-2/{frame,frame-after}.png
 *
 * Each `frame.png` is a synthetic "desktop with a focused window" — solid
 * background + a window chrome rectangle + a red close-button rectangle in
 * the upper-right of the chrome. `frame-after.png` is the same desktop with
 * the close-button repainted in green to simulate a state change after the
 * click.
 *
 * The numbers below are tuned to match the canned coords in
 * `src/stubs/stub-vlm.ts` so the absolute reconstruction lands inside the
 * close-button hot region.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "fixtures");

const SPECS = [
  {
    id: "single-1920x1080",
    displays: [
      {
        dir: "single-1920x1080/display-1",
        width: 1920,
        height: 1080,
        background: { r: 30, g: 30, b: 38 },
      },
    ],
  },
  {
    id: "ultra-wide-5120x1440",
    displays: [
      {
        dir: "ultra-wide-5120x1440/display-1",
        width: 5120,
        height: 1440,
        background: { r: 24, g: 26, b: 34 },
      },
    ],
  },
  {
    id: "multi-display-composite",
    displays: [
      {
        dir: "multi-display-composite/display-1",
        width: 1920,
        height: 1080,
        background: { r: 32, g: 28, b: 30 },
      },
      {
        dir: "multi-display-composite/display-2",
        width: 2560,
        height: 1440,
        background: { r: 20, g: 30, b: 36 },
      },
    ],
  },
];

/**
 * Render one PNG: a flat background, a window chrome rectangle in the upper
 * portion of the canvas, and a 32x32 close-button square at the upper-right
 * of the chrome. `closeColor` lets the "after" frame swap red→green.
 */
async function renderDesktop({ width, height, background, closeColor }) {
  const chromeColor = { r: 50, g: 50, b: 65 };
  // Window chrome occupies a horizontal band across the top; close button
  // is fixed at width-140..width-108, y 8..40.
  const chromeBand = await sharp({
    create: {
      width,
      height: 64,
      channels: 3,
      background: chromeColor,
    },
  })
    .png()
    .toBuffer();

  // Close button square (32x32).
  const closeBtn = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: closeColor,
    },
  })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background,
    },
  })
    .composite([
      { input: chromeBand, top: 0, left: 0 },
      { input: closeBtn, top: 8, left: width - 140 },
    ])
    .png()
    .toBuffer();
}

async function main() {
  for (const spec of SPECS) {
    for (const display of spec.displays) {
      const outDir = join(ROOT, display.dir);
      mkdirSync(outDir, { recursive: true });
      const before = await renderDesktop({
        ...display,
        closeColor: { r: 220, g: 60, b: 60 },
      });
      const after = await renderDesktop({
        ...display,
        closeColor: { r: 60, g: 200, b: 90 },
      });
      writeFileSync(join(outDir, "frame.png"), before);
      writeFileSync(join(outDir, "frame-after.png"), after);
      // eslint-disable-next-line no-console
      console.log(
        `wrote ${display.dir}/{frame,frame-after}.png (${display.width}x${display.height})`,
      );
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
