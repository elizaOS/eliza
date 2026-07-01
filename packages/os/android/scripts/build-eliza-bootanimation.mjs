#!/usr/bin/env node
// Pack the rendered elizaOS boot-splash frames into bootanimation.zip in the
// uncompressed-store format AOSP's bootanimation daemon requires.
//
// This is the elizaOS-specific companion to
// generate-eliza-bootanimation.mjs: that script renders the white logo on the
// elizaOS blue field into vendor/eliza/bootanimation/{part0,part1}/, and this
// one packs those frames + desc.txt into
// vendor/eliza/bootanimation/bootanimation.zip (consumed by `make
// bootanimation`). Frame layout inspection + zip packing reuse the
// brand-agnostic helpers in
// packages/scripts/distro-android/build-bootanimation.mjs.
//
// Usage:
//   node packages/os/android/scripts/build-eliza-bootanimation.mjs
//   node packages/os/android/scripts/build-eliza-bootanimation.mjs --check
//
// Flags:
//   --frames <dir>   Override the frame directory (defaults to the eliza
//                    vendor bootanimation dir).
//   --out <path>     Override the output zip (defaults to <frames>/bootanimation.zip).
//   --check          Verify the frame layout without writing the zip.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildBootAnimationZip,
  inspectBootAnimationDir,
} from "../../../scripts/distro-android/build-bootanimation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRAMES = path.resolve(here, "../vendor/eliza/bootanimation");

function parseArgs(argv) {
  const args = { framesDir: DEFAULT_FRAMES, outPath: null, check: false };
  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--frames") {
      args.framesDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--out") {
      args.outPath = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--check") {
      args.check = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node packages/os/android/scripts/build-eliza-bootanimation.mjs [--frames <DIR>] [--out <ZIP>] [--check]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.outPath ??= path.join(args.framesDir, "bootanimation.zip");
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.check) {
    const { issues } = inspectBootAnimationDir(args.framesDir);
    if (issues.length > 0) {
      console.error(`[bootanimation:check] FAIL\n - ${issues.join("\n - ")}`);
      process.exit(1);
    }
    console.log(`[bootanimation:check] ${args.framesDir} is well-formed.`);
    return;
  }
  buildBootAnimationZip(args);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { main, parseArgs };
