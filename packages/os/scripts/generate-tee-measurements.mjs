#!/usr/bin/env node
import {
  parseArgs,
  sha256File,
  writeJson,
} from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const output = args.output;

if (!output) {
  console.error("error: --output is required");
  process.exit(1);
}

const requiredInputs = ["boot", "os", "agent", "policy"];
const measurements = {};

for (const name of requiredInputs) {
  const filePath = args[name];
  if (!filePath || typeof filePath !== "string") {
    console.error(`error: --${name} is required`);
    process.exit(1);
  }
  measurements[name] = `sha256:${await sha256File(filePath)}`;
}

for (const name of ["device", "container", "npuFirmware"]) {
  const filePath = args[name];
  if (filePath && typeof filePath === "string") {
    measurements[name] = `sha256:${await sha256File(filePath)}`;
  }
}

await writeJson(output, {
  schemaVersion: 1,
  generatedBy: "packages/os/scripts/generate-tee-measurements.mjs",
  measurements,
});
console.log(`TEE measurements written: ${output}`);
