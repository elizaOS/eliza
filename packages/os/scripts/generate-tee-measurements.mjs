#!/usr/bin/env node
import {
  optionalTeeMeasurementNames,
  parseArgs,
  readJson,
  requiredTeeMeasurementNames,
  sha256CanonicalJson,
  sha256File,
  writeJson,
} from "./os-release-lib.mjs";

// `policy` is special: its measurement is the sha256 of the CANONICALIZED
// confidential-policy.json (stable key order), not of the raw file bytes. That
// makes the digest depend only on the policy's semantic content, so an attacker
// who edits a policy setting changes the digest and the launch fails against the
// signed golden manifest. All other measurements hash raw component bytes.
const POLICY_NAME = "policy";

const args = parseArgs(process.argv.slice(2));
const output = args.output;

if (!output) {
  console.error("error: --output is required");
  process.exit(1);
}

async function measure(name, filePath) {
  if (name === POLICY_NAME) {
    return sha256CanonicalJson(await readJson(filePath));
  }
  return `sha256:${await sha256File(filePath)}`;
}

const measurements = {};

for (const name of requiredTeeMeasurementNames) {
  const filePath = args[name];
  if (!filePath || typeof filePath !== "string") {
    console.error(`error: --${name} is required`);
    process.exit(1);
  }
  measurements[name] = await measure(name, filePath);
}

for (const name of optionalTeeMeasurementNames) {
  const filePath = args[name];
  if (filePath && typeof filePath === "string") {
    measurements[name] = await measure(name, filePath);
  }
}

await writeJson(output, {
  schemaVersion: 1,
  generatedBy: "packages/os/scripts/generate-tee-measurements.mjs",
  measurements,
});
console.log(`TEE measurements written: ${output}`);
