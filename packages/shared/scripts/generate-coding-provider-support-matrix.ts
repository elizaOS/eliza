/**
 * Emits the canonical coding-provider support matrix as a reviewable JSON
 * artifact without introducing Node-only code into the shared package barrel.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CODING_PROVIDER_SUPPORT_MATRIX } from "../src/contracts/coding-agent-capabilities.js";

const outputFlagIndex = process.argv.indexOf("--output");
const outputPath =
  outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1]?.trim() : undefined;
if (outputFlagIndex >= 0 && !outputPath) {
  throw new Error("--output requires a destination path");
}

const serialized = `${JSON.stringify(CODING_PROVIDER_SUPPORT_MATRIX, null, 2)}\n`;
if (outputPath) {
  const destination = resolve(outputPath);
  await writeFile(destination, serialized, "utf8");
  process.stdout.write(`${destination}\n`);
} else {
  process.stdout.write(serialized);
}
