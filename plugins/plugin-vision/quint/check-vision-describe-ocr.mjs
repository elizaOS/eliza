import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2]);
const output = testOutputPath("quint-vision-describe-ocr");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    "--main=VisionDescribeOcr",
    "--backend=typescript",
    "--seed=20261113",
    "--max-samples=200",
    "--n-traces=200",
    "--max-steps=3",
    "--invariant=FailureKeepsItsReason",
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" },
);
const value = (field) =>
  typeof field === "boolean" ? field : Number(field["#bigint"]);
const cases = new Map();
for (const file of readdirSync(directory)) {
  for (const state of JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states) {
    if (value(state.phase) !== 2) continue;
    const fields = Object.fromEntries(
      [
        "image",
        "hasText",
        "backend",
        "ocrInput",
        "passThrough",
        "reason",
        "ocrText",
      ].map((key) => [key, value(state[key])]),
    );
    cases.set(`${fields.image}:${fields.hasText}:${fields.backend}`, fields);
  }
}
assert.equal(
  cases.size,
  12,
  "All twelve image, text and backend scenarios must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify(
    [...cases.values()].sort(
      (a, b) =>
        a.image - b.image ||
        Number(a.hasText) - Number(b.hasText) ||
        a.backend - b.backend,
    ),
  ),
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-vision/vitest.config.ts",
    "plugins/plugin-vision/src/vision-context-augmenter.test.ts",
    "-t",
    "matches the generated describe OCR outcome",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, ELIZA_VISION_DESCRIBE_OCR_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 600000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Vision describe OCR conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 12);
assert.equal(summary.numFailedTests, 0);
console.log(
  "Twelve model-generated describe OCR cases match the production augmenter, sharp and coord adapter",
);
