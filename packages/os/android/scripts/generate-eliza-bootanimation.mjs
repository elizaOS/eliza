#!/usr/bin/env node
// Render the elizaOS boot splash for the AOSP fork: the white elizaOS logo
// on the elizaOS blue field, as the PNG frame sequence AOSP's bootanimation
// daemon plays during boot (kernel logo -> this splash -> Eliza launcher).
//
// Frames land under vendor/eliza/bootanimation/{part0,part1}/ and are packed
// into bootanimation.zip by build-eliza-bootanimation.mjs (`make bootanimation`).
// The rendered frames + zip are gitignored — this regenerates them from the
// canonical brand SVG on demand, the same way packages/os/linux/elizaos
// renders its branding.
//
// Uses sharp (the repo's image toolchain) to rasterize + composite the SVG;
// no external ImageMagick dependency.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

const LOGO_SVG = path.join(
  repoRoot,
  "packages/app/public/brand/logos/logo_white_nobg.svg",
);
const BOOTANIM_DIR = path.resolve(here, "../vendor/eliza/bootanimation");
const PART0 = path.join(BOOTANIM_DIR, "part0"); // one-shot intro: logo fades in
const PART1 = path.join(BOOTANIM_DIR, "part1"); // idle loop until boot completes

// Device framebuffer geometry (matches desc.txt); the eliza_cf_*_phone
// products use the Cuttlefish 1080x2400 panel.
const WIDTH = 1080;
const HEIGHT = 2400;
const FPS = 30;
const LOGO_W = 480;
const INTRO_FRAMES = 16;
// elizaOS blue, identical to the Linux greeter field (#0B35F1).
const BLUE = { r: 0x0b, g: 0x35, b: 0xf1, alpha: 1 };

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error(
    "sharp is required to render the boot splash (it ships with the repo toolchain; run `bun install`)",
  );
  process.exit(1);
}

if (!fs.existsSync(LOGO_SVG)) {
  console.error(`Missing brand logo: ${LOGO_SVG}`);
  process.exit(1);
}

fs.rmSync(PART0, { recursive: true, force: true });
fs.rmSync(PART1, { recursive: true, force: true });
fs.mkdirSync(PART0, { recursive: true });
fs.mkdirSync(PART1, { recursive: true });

const blueCanvas = () =>
  sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 4, background: BLUE },
  });

// White logo centered on a full-size transparent canvas, as raw RGBA so we
// can scale its alpha per frame for the fade-in.
const logoPng = await sharp(fs.readFileSync(LOGO_SVG))
  .resize({ width: LOGO_W })
  .png()
  .toBuffer();
const logoLayer = await sharp({
  create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: logoPng, gravity: "center" }])
  .raw()
  .toBuffer();

// Composite the logo layer (alpha scaled by `opacity`) over the blue field.
async function renderFrame(opacity) {
  const layer = Buffer.from(logoLayer);
  if (opacity < 1) {
    for (let j = 3; j < layer.length; j += 4) {
      layer[j] = Math.round(layer[j] * opacity);
    }
  }
  const faded = await sharp(layer, {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 },
  })
    .png()
    .toBuffer();
  return blueCanvas()
    .composite([{ input: faded }])
    .flatten({ background: BLUE })
    .png()
    .toBuffer();
}

// Intro: fade the logo in. Frame 0 is the bare blue field; the last frame is
// the full logo.
for (let i = 0; i < INTRO_FRAMES; i += 1) {
  const frame = await renderFrame(i / (INTRO_FRAMES - 1));
  fs.writeFileSync(
    path.join(PART0, `${String(i).padStart(4, "0")}.png`),
    frame,
  );
}

// Idle loop: the fully-opaque logo, held until the framework starts.
fs.writeFileSync(path.join(PART1, "0000.png"), await renderFrame(1));

// desc.txt: play the intro once, then loop the idle frame until boot.
fs.writeFileSync(
  path.join(BOOTANIM_DIR, "desc.txt"),
  `${WIDTH} ${HEIGHT} ${FPS}\np 1 0 part0\np 0 0 part1\n`,
);

console.log(
  `Rendered elizaOS boot splash into ${BOOTANIM_DIR} (${INTRO_FRAMES} intro frames + idle loop)`,
);
console.log(
  `Pack it with: node packages/os/android/scripts/build-eliza-bootanimation.mjs --frames ${BOOTANIM_DIR} --out ${BOOTANIM_DIR}/bootanimation.zip`,
);
