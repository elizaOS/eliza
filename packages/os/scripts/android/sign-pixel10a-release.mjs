#!/usr/bin/env node
/**
 * Sign the Eliza Pixel 10a release (android/releases/pixel10a-eliza.json) on the image
 * host. Downstream brands bind their own release descriptor through
 * aosp-release-signing.mjs `signingMain(args, release)` with their repository root.
 *
 *   node packages/os/scripts/android/sign-pixel10a-release.mjs \
 *     --target-files /abs/unsigned-target_files.zip --target-files-sha256 HEX \
 *     --keys-dir /dev/shm/keys --releasetools /abs/otatools/bin --out /abs/new-dir [--dry-run] ...
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signingMain } from "./aosp-release-signing.mjs";

export const ELIZA_PIXEL10A_RELEASE = Object.freeze({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  productName: "eliza_stallion_phone",
  descriptorFile: "android/releases/pixel10a-eliza.json",
  sourceLockPath: "android/sources/pixel10a-stallion.json",
});

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await signingMain(process.argv.slice(2), ELIZA_PIXEL10A_RELEASE);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
