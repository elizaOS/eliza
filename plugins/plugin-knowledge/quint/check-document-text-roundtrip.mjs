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
const output = testOutputPath("quint-document-text-roundtrip");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    "--main=DocumentTextRoundTrip",
    "--backend=typescript",
    "--seed=20261113",
    "--max-samples=120",
    "--n-traces=120",
    "--max-steps=4",
    "--invariant=DetailTextIsExact",
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { cwd: root, stdio: "inherit" },
);
const cases = new Map();
for (const file of readdirSync(directory)) {
  if (!file.endsWith(".itf.json")) continue;
  for (const state of JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states) {
    if (Number(state.phase["#bigint"]) !== 3) continue;
    const sample = Number(state.sample["#bigint"]);
    cases.set(`${sample}:${state.saveRequested}`, {
      sample,
      original: state.original,
      observed: state.observed,
      saveRequested: state.saveRequested,
      saveRequests: Number(state.saveRequests["#bigint"]),
    });
  }
}
assert.equal(
  cases.size,
  6,
  "All six read/save-or-discard outcomes must replay",
);
const input = path.join(directory, "cases.json");
writeFileSync(input, JSON.stringify([...cases.values()]));
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config=plugins/plugin-knowledge/vitest.config.ts",
    "plugins/plugin-knowledge/test/document-text-roundtrip-model.pglite.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, ELIZA_DOCUMENT_TEXT_MODEL_CASES: input },
    stdio: "inherit",
    // Include cold workspace-source compilation and PGlite initialization.
    // The actual test and fixture deadlines remain bounded by Vitest.
    timeout: 600000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Document text route conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 6);
assert.equal(summary.numFailedTests, 0);
console.log(
  "Six model-generated exact-text outcomes match the real document routes and PGlite store",
);
