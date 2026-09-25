#!/usr/bin/env node
// Eliza defaults for the shared Android boot-animation packer.
import { fileURLToPath } from "node:url";
import {
  main as packAnimation,
  parseArgs as parsePackingArgs,
} from "../distro-android/build-bootanimation.ts";

const options = {
  defaultFrames: fileURLToPath(
    new URL("../../android/vendor/eliza/bootanimation", import.meta.url),
  ),
  usage:
    "Usage: node scripts/android/build-eliza-bootanimation.ts [--frames <DIR>] [--out <ZIP>] [--check]",
};

export function parseArgs(argv) {
  return parsePackingArgs(argv, options);
}

export function main(argv = process.argv.slice(2)) {
  return packAnimation(argv, options);
}

if (import.meta.main) main();
