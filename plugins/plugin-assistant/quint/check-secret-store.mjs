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
const name = path.basename(model, ".qnt");
assert.equal(name, "SelfWorldCreation");
const terminal = 2;
const expected = 2;
const output = testOutputPath("quint-secret-store", name);
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
    "--max-samples=80",
    "--n-traces=80",
    "--max-steps=4",
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
    if (Number(state.phase["#bigint"]) !== terminal) continue;
    const value = Object.fromEntries(
      Object.entries(state).map(([key, item]) => [
        key,
        item && typeof item === "object" && "#bigint" in item
          ? Number(item["#bigint"])
          : item,
      ]),
    );
    cases.set(value.scenario, value);
  }
}
assert.equal(cases.size, expected);
const input = path.join(directory, "cases.json");
const report = path.join(directory, "vitest.json");
writeFileSync(
  input,
  JSON.stringify({ model: name, cases: [...cases.values()] }),
);
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "src/features/secrets/storage/secret-store-model.pglite.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "plugins/plugin-assistant"),
    env: { ...process.env, ELIZA_SECRET_STORE_CASES: input },
    stdio: "inherit",
    timeout: 600000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0);
assert.equal(JSON.parse(readFileSync(report, "utf8")).numPassedTests, expected);
console.log(`${name}: all ${expected} generated PGlite cases match`);
