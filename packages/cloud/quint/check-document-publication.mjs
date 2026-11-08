/** Require the real document graph transaction and HTTP boundary regressions. */
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
  path.join(root, "packages/cloud/quint/document_publication.qnt"),
);
const output = testOutputPath("quint-document-publication");
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
    "packages/cloud/api/__tests__/documents-publication-atomicity.pglite.test.ts",
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
assert.equal(result.status, 0, `Document conformance failed: ${directory}`);
assert.equal(result.signal, null);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.tests, 6);
assert.equal(summary.executedTests, 6);
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
    "document publication retains complete text and every ordered fragment",
    "fragment failure rolls back the parent and the whole fragment batch",
    "parent deletion failure rolls back fragment deletion through the real route",
    "a suppressed parent deletion rolls back fragment deletion through the real route",
    "document deletion removes its whole graph and a second request reports absence",
    "a foreign document scope cannot delete the parent or its fragments",
  ].sort(),
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary }, null, 2)}\n`,
);
console.log(
  `Document publication conformance passed six required tests. Evidence ${directory}`,
);
