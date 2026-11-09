/** Check exact named device state flows through the real plugin and SQL queue. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const suites = new Map([
  [
    "DevicePhotosFilter",
    {
      test: "test/photos-filter.e2e.test.ts",
      name: "Photos Filter discovery gates the real proposal and retains one count-only receipt",
      output: "quint-device-photos-filter",
    },
  ],
  [
    "DeviceFilesNegotiation",
    {
      test: "test/files-negotiation.e2e.test.ts",
      name: "Files capability negotiation preserves review, proposal visibility, and revocation over HTTP",
      output: "quint-device-files-negotiation",
    },
  ],
]);
const plugin = path.resolve(import.meta.dirname, "..");
const selected = process.argv[2];
assert(selected, "Expected the device action model path");
const model = path.basename(selected, ".qnt");
assert.equal(
  path.resolve(selected),
  path.join(import.meta.dirname, `${model}.qnt`),
);
const suite = suites.get(model);
assert(suite, `No device action conformance suite for ${model}`);

const outputRoot = testOutputPath(suite.output);
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "conformance-"));
const report = path.join(output, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "../../packages/scripts/run-vitest.ts",
    "run",
    "--config",
    "vitest.device-actions.config.ts",
    suite.test,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: plugin, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, `${model} conformance failed`);
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, suite.test),
  [suite.name],
);
console.log(`${model} runtime and SQL conformance passed`);
