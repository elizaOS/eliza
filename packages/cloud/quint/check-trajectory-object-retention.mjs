/** Require the real trajectory retained-object regressions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/trajectory_object_retention.qnt"),
);
const output = testOutputPath("quint-trajectory-object-retention");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    "bun",
    "test",
    "--conditions=eliza-source",
    "packages/cloud/shared/src/lib/services/llm-trajectory.pglite.test.ts",
    "--timeout=120000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 200000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  `Trajectory retention conformance failed: ${directory}`,
);
assert.equal(result.signal, null);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.tests, 10);
assert.equal(summary.executedTests, 10);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
const names = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name === "testcase") names.push(tag.attributes.name);
});
parser.write(xml).close();
assert.deepEqual(
  names.sort(),
  [
    "without a private store, bodies are encrypted inline and BLOB is never written",
    "with the private binding, encrypted payloads go only to TRAJECTORY_BLOB",
    "a lost SQL acknowledgement retains the committed payload and complete training export",
    "a definite insert failure retains its unreferenced object without hiding the SQL error",
    "a private-store row without the private store configured fails loudly",
    "missing payloads fail listing and export instead of returning incomplete training data",
    "a ciphertext moved to another column does not decrypt",
    "legacy plaintext rows (inline and general-bucket) still read",
    "deletes expired rows and their payload objects in every store, keeps recent rows",
    "keeps the row when its payload object cannot be deleted",
  ].sort(),
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary }, null, 2)}\n`,
);
console.log(
  `Trajectory retention conformance passed ten required tests. Evidence ${directory}`,
);
