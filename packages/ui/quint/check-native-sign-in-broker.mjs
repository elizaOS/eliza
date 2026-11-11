/** Run the real renderer broker and parser with controlled platform ports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const ui = path.join(root, "packages/ui");
const file = "src/android-cloud/__e2e__/native-cloud-sign-in.test.ts";
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(ui, "quint/NativeSignInBroker.qnt"),
);
const output = testOutputPath("quint-native-sign-in-broker");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "tests.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.config.ts",
    "--no-file-parallelism",
    file,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: ui,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
    },
    stdio: "inherit",
  },
);
if (child.error) throw child.error;
assert.equal(child.status, 0, "Native sign-in broker implementation failed");
const result = JSON.parse(readFileSync(report, "utf8"));
assert.equal(result.success, true);
assert.equal(result.testResults.length, 1);
const [suite] = result.testResults;
assert.equal(suite.name, path.join(ui, file));
assert.equal(suite.assertionResults.length, 18);
assert(suite.assertionResults.every((test) => test.status === "passed"));
console.log(`Native sign-in broker passed 18 checks. Report ${report}`);
