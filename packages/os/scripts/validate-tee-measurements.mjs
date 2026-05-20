#!/usr/bin/env node
import {
  parseArgs,
  readJson,
  validateTeeMeasurements,
} from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const input =
  typeof args.input === "string"
    ? args.input
    : "packages/os/release/schema/tee-measurements.example.json";

const result = validateTeeMeasurements(await readJson(input));
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`error: ${error}`);
  }
  process.exit(1);
}

console.log(`TEE measurements valid: ${input}`);
