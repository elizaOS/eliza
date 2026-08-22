/**
 * Writes the deterministic provider-certification report used by CI and PR
 * evidence. This command never contacts a provider or consumes paid quota.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDeterministicProviderCertification } from "../src/services/provider-certification.js";

const outputIndex = process.argv.indexOf("--output");
const output =
  outputIndex >= 0 ? process.argv[outputIndex + 1]?.trim() : undefined;
if (outputIndex >= 0 && !output) {
  throw new Error("--output requires a destination path");
}
const report = runDeterministicProviderCertification();
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  const destination = resolve(output);
  await writeFile(destination, serialized, "utf8");
  process.stdout.write(`${destination}\n`);
} else {
  process.stdout.write(serialized);
}
