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
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("quint-oauth-status-heartbeat");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    process.argv[2],
    "--main=OAuthStatusHeartbeat",
    "--backend=typescript",
    "--seed=20261113",
    "--max-samples=40",
    "--n-traces=40",
    "--max-steps=5",
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
    if (!state.closed) continue;
    const value = Object.fromEntries(
      Object.entries(state).map(([key, item]) => [
        key,
        item && typeof item === "object" && "#bigint" in item
          ? Number(item["#bigint"])
          : item,
      ]),
    );
    cases.set(value.goal, value);
  }
}
assert.equal(cases.size, 2);
const input = path.join(directory, "cases.json");
const report = path.join(directory, "vitest.json");
writeFileSync(input, JSON.stringify([...cases.values()]));
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "test/oauth-status-sse-heartbeat.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "packages/agent"),
    env: { ...process.env, ELIZA_OAUTH_STATUS_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 600000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0);
assert.equal(JSON.parse(readFileSync(report, "utf8")).numPassedTests, 2);
console.log("OAuthStatusHeartbeat: both generated HTTP lifecycles match");
