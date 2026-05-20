#!/usr/bin/env bun
/**
 * Generate PWA icons from the SVG favicon.
 *
 * Uses sharp to rasterize the SVG into PNG icons at the sizes required by the
 * Web App Manifest and the Solana dApp Store.
 *
 * Usage:
 *   bun run scripts/generate-pwa-icons.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SVG_PATH = path.join(ROOT, "apps/web/public/favicon.svg");
const ICONS_DIR = path.join(ROOT, "apps/web/public/icons");

const SIZES = [144, 192, 512];

async function generateIcons() {
  // Dynamic import sharp — it may need to be installed
  let sharp: typeof import("sharp");
  try {
    sharp = await import("sharp");
  } catch {
    console.error(
      "sharp is not installed. Run: bun add -d sharp\nThen re-run this script.",
    );
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(SVG_PATH);

  fs.mkdirSync(ICONS_DIR, { recursive: true });

  for (const size of SIZES) {
    // Regular icon — transparent background, centered
    const regularPath = path.join(ICONS_DIR, `icon-${size}.png`);
    await sharp
      .default(svgBuffer)
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(regularPath);
    console.log(`  Created ${regularPath}`);

    // Maskable icon — padded with safe zone (10% padding), solid background
    const maskablePath = path.join(ICONS_DIR, `icon-maskable-${size}.png`);
    const innerSize = Math.round(size * 0.8); // 80% of total to leave safe zone
    const innerIcon = await sharp
      .default(svgBuffer)
      .resize(innerSize, innerSize, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    await sharp
      .default({
        create: {
          width: size,
          height: size,
          channels: 4,
          background: { r: 0, g: 102, b: 255, alpha: 1 }, // #0066FF brand blue
        },
      })
      .composite([
        {
          input: innerIcon,
          gravity: "centre",
        },
      ])
      .png()
      .toFile(maskablePath);
    console.log(`  Created ${maskablePath}`);
  }

  console.log("\nPWA icons generated successfully.");
}

generateIcons().catch((err) => {
  console.error("Failed to generate icons:", err);
  process.exit(1);
});
