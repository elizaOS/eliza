import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2]);
const name = path.basename(model, ".qnt");
assert(["CloudAuthClear", "CloudStreamCompletion"].includes(name));
const terminal = name === "CloudAuthClear" ? 3 : 2;
const expectedCases = name === "CloudAuthClear" ? 4 : 5;
const output = testOutputPath("quint-cloud-lifecycle", name);
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    `--main=${name}`,
    "--backend=typescript",
    "--seed=20261113",
    "--max-samples=120",
    "--n-traces=120",
    "--max-steps=4",
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { cwd: root, stdio: "inherit" }
);
const cases = new Map();
for (const file of readdirSync(directory)) {
  if (!file.endsWith(".itf.json")) continue;
  for (const state of JSON.parse(readFileSync(path.join(directory, file), "utf8")).states) {
    if (Number(state.phase["#bigint"]) !== terminal) continue;
    const decoded = Object.fromEntries(
      Object.entries(state).map(([key, value]) => [
        key,
        value && typeof value === "object" && "#bigint" in value ? Number(value["#bigint"]) : value,
      ])
    );
    cases.set(decoded.scenario, decoded);
  }
}
assert.equal(cases.size, expectedCases, "Every finite lifecycle case must replay");
const input = path.join(directory, "cases.json");
writeFileSync(input, JSON.stringify({ model: name, cases: [...cases.values()] }));
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "__tests__/cloud-lifecycle-model.http.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "plugins/plugin-elizacloud"),
    env: { ...process.env, ELIZA_CLOUD_LIFECYCLE_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 600000,
  }
);
if (result.error) throw result.error;
assert.equal(result.status, 0, `${name} real lifecycle conformance failed`);
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, expectedCases);
assert.equal(summary.numFailedTests, 0);
console.log(`${name}: ${expectedCases} generated cases match real HTTP/runtime behavior`);
