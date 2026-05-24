#!/usr/bin/env node
// Regenerate the elizaOS Android launcher icons + app splash from the
// canonical brand SVG (the white elizaOS face mark,
// packages/app/public/brand/logos/logo_white_nobg.svg). This is the single
// source of truth for the Eliza app icon across every platform — the same
// mark feeds the Android boot animation and the Linux Plymouth splash.
//
// Deterministic: every asset is rasterized from the SVG with sharp at fixed
// densities, so re-running reproduces byte-comparable output.
//
// Outputs (under packages/app-core/platforms/android/app/src/main/res):
//   mipmap-<d>/ic_launcher.png            legacy square icon (white mark on
//                                          elizaOS blue)
//   mipmap-<d>/ic_launcher_round.png      legacy round icon (blue circle)
//   mipmap-<d>/ic_launcher_foreground.png adaptive foreground (white mark,
//                                          transparent, safe-zone inset)
//   mipmap-<d>/ic_launcher_monochrome.png themed-icon glyph (white mark,
//                                          transparent — Android 13+ tints it)
//   drawable[-port|-land-<d>]/splash.png  branded launch splash (white mark
//                                          on elizaOS blue)
//
// Background-color choices:
//   - Adaptive + legacy icon background: elizaOS blue #0B35F1. The face mark
//     is a white knockout, so blue gives the strongest contrast and matches
//     the boot animation / Plymouth splash. (The adaptive bg is also set via
//     @color/ic_launcher_background in res/values/ic_launcher_background.xml.)
//   - Splash background: elizaOS blue #0B35F1, for continuity with the boot
//     animation that immediately precedes it (boot is blue end-to-end).
//
// Usage:
//   node packages/scripts/distro-android/generate-launcher-icons.mjs
//   node packages/scripts/distro-android/generate-launcher-icons.mjs --check

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const LOGO_SVG = path.join(
  repoRoot,
  "packages/app/public/brand/logos/logo_white_nobg.svg",
);
const RES_DIR = path.join(
  repoRoot,
  "packages/app-core/platforms/android/app/src/main/res",
);

// elizaOS blue — identical to the boot animation field and Linux greeter.
const BLUE = { r: 0x0b, g: 0x35, b: 0xf1, alpha: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// Legacy launcher icon edge (px) per density bucket.
const LAUNCHER_SIZES = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};
// Adaptive foreground / monochrome edge (px) — always 108dp.
const FOREGROUND_SIZES = {
  "mipmap-mdpi": 108,
  "mipmap-hdpi": 162,
  "mipmap-xhdpi": 216,
  "mipmap-xxhdpi": 324,
  "mipmap-xxxhdpi": 432,
};
// Launch splash sizes (width x height) per orientation+density bucket.
const SPLASH_SIZES = {
  drawable: [480, 320],
  "drawable-land-mdpi": [480, 320],
  "drawable-land-hdpi": [800, 480],
  "drawable-land-xhdpi": [1280, 720],
  "drawable-land-xxhdpi": [1600, 960],
  "drawable-land-xxxhdpi": [1920, 1280],
  "drawable-port-mdpi": [320, 480],
  "drawable-port-hdpi": [480, 800],
  "drawable-port-xhdpi": [720, 1280],
  "drawable-port-xxhdpi": [960, 1600],
  "drawable-port-xxxhdpi": [1280, 1920],
};

// Fraction of the icon edge the mark occupies. Legacy icons fill more of the
// tile; adaptive foreground keeps the mark inside the ~66dp safe zone so the
// launcher mask never clips it.
const LEGACY_MARK_RATIO = 0.66;
const FOREGROUND_MARK_RATIO = 0.5;
const SPLASH_MARK_RATIO = 0.42; // of the shorter splash edge

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error(
    "sharp is required to render launcher icons (it ships with the repo toolchain; run `bun install`)",
  );
  process.exit(1);
}

if (!fs.existsSync(LOGO_SVG)) {
  console.error(`Missing brand logo: ${LOGO_SVG}`);
  process.exit(1);
}
const svg = fs.readFileSync(LOGO_SVG);

async function markPng(edge) {
  return sharp(svg)
    .resize({ width: Math.round(edge), height: Math.round(edge), fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

// White mark centered on a solid square field of `bg`.
async function compositeOnField(edge, markEdge, bg) {
  const mark = await markPng(markEdge);
  return sharp({
    create: { width: edge, height: edge, channels: 4, background: bg },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
}

// White mark centered on a transparent square (adaptive foreground / mono).
async function markOnTransparent(edge, markEdge) {
  const mark = await markPng(markEdge);
  return sharp({
    create: { width: edge, height: edge, channels: 4, background: TRANSPARENT },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
}

// Round icon: white mark on a blue circle (transparent corners).
async function roundIcon(edge, markEdge) {
  const square = await compositeOnField(edge, markEdge, BLUE);
  const r = edge / 2;
  const circleMask = Buffer.from(
    `<svg width="${edge}" height="${edge}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`,
  );
  return sharp(square)
    .composite([{ input: circleMask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function splash(width, height, markEdge) {
  const mark = await markPng(markEdge);
  return sharp({
    create: { width, height, channels: 4, background: BLUE },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
}

const CHECK = process.argv.slice(2).includes("--check");

async function write(relDir, name, buf) {
  const dir = path.join(RES_DIR, relDir);
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing res directory: ${relDir}`);
  }
  const out = path.join(dir, name);
  if (CHECK) {
    if (!fs.existsSync(out)) {
      throw new Error(`[check] missing expected asset: ${relDir}/${name}`);
    }
    return;
  }
  fs.writeFileSync(out, buf);
  console.log(`wrote ${relDir}/${name}`);
}

if (CHECK) {
  console.log("[check] verifying generated launcher/splash assets exist…");
}

for (const [dir, edge] of Object.entries(LAUNCHER_SIZES)) {
  const markEdge = Math.round(edge * LEGACY_MARK_RATIO);
  await write(dir, "ic_launcher.png", await compositeOnField(edge, markEdge, BLUE));
  await write(dir, "ic_launcher_round.png", await roundIcon(edge, markEdge));
}

for (const [dir, edge] of Object.entries(FOREGROUND_SIZES)) {
  const markEdge = Math.round(edge * FOREGROUND_MARK_RATIO);
  await write(dir, "ic_launcher_foreground.png", await markOnTransparent(edge, markEdge));
  await write(dir, "ic_launcher_monochrome.png", await markOnTransparent(edge, markEdge));
}

for (const [dir, [w, h]] of Object.entries(SPLASH_SIZES)) {
  const markEdge = Math.round(Math.min(w, h) * SPLASH_MARK_RATIO);
  await write(dir, "splash.png", await splash(w, h, markEdge));
}

console.log(
  CHECK
    ? "[check] all expected launcher/splash assets present."
    : "Regenerated elizaOS launcher icons + splash from the canonical brand SVG.",
);
