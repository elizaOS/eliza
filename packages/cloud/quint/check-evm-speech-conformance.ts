/** Runs the existing EVM persistence and speech cutover suites for their models. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const suites = new Map([
  [
    "evm_sweep_nonce.qnt",
    new Map([
      [
        "packages/cloud/shared/src/lib/services/evm-sweep-authority.pglite.test.ts",
        20,
      ],
    ]),
  ],
  [
    "speech_host_cutover.qnt",
    new Map([
      ["packages/cloud/scripts/speech-host-cutover-admission.test.ts", 37],
      ["packages/cloud/api/__tests__/speech-relay-worker.test.ts", 18],
      ["packages/cloud/api/__tests__/speech-worker-contract.test.ts", 22],
    ]),
  ],
]);

const model = path.resolve(root, process.argv[2] ?? "");
const name = path.basename(model);
const expected = suites.get(name);
assert(
  expected && path.dirname(model) === import.meta.dirname,
  "Expected an EVM sweep nonce or speech host cutover model path",
);
const output = testOutputPath(
  `quint-${name.replaceAll("_", "-").slice(0, -4)}`,
);
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=30000",
    `--reporter-outfile=${report}`,
    "--reporter=junit",
    ...expected.keys(),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, `Conformance failed for ${name}`);
const summary = parseJunitSummary(readFileSync(report, "utf8"));
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.equal(summary.files.length, expected.size);
assert.deepEqual(
  new Map(
    summary.files.map(({ file, executedTests }) => [file, executedTests]),
  ),
  expected,
  "Every required conformance suite must execute",
);
console.log(`${name} passed ${summary.executedTests} checks. Report ${report}`);
