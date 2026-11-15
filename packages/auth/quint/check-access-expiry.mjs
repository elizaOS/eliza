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
const output = testOutputPath("quint-access-expiry");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    process.argv[2],
    "--main=AccessExpiryRecovery",
    "--backend=typescript",
    "--seed=20261113",
    "--max-samples=240",
    "--n-traces=240",
    "--max-steps=8",
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
assert.equal(cases.size, 9, "Every finite browser recovery case must run");
const input = path.join(directory, "cases.json");
const report = path.join(directory, "conformance.json");
writeFileSync(input, JSON.stringify([...cases.values()]));
const result = spawnSync(
  "bun",
  [
    "test",
    "test/login/sdk-session-expiry-model.browser.test.ts",
    "--timeout=120000",
  ],
  {
    cwd: path.join(root, "packages/auth"),
    env: {
      ...process.env,
      ELIZA_ACCESS_EXPIRY_CASES: input,
      ELIZA_ACCESS_EXPIRY_REPORT: report,
    },
    stdio: "inherit",
    timeout: 600000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Real browser access-expiry conformance failed");
assert.equal(JSON.parse(readFileSync(report, "utf8")).passed, 9);
console.log(
  "AccessExpiryRecovery: all nine generated cases match real browser HTTP behavior",
);
