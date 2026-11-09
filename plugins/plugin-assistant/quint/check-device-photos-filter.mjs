/** Check the named Photos Filter flow through the real plugin and SQL queue. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const plugin = path.resolve(import.meta.dirname, "..");
const model = path.join(import.meta.dirname, "DevicePhotosFilter.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);

const test = "test/photos-filter.e2e.test.ts";
const names = [
  "Photos Filter discovery gates the real proposal and retains one count-only receipt",
];
const outputRoot = testOutputPath("quint-device-photos-filter");
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
    test,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: plugin, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Photos Filter conformance failed");
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, test),
  names,
);
console.log("Photos Filter runtime and SQL conformance passed");
