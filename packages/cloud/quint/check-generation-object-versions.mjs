/** Require the real immutable generation pointer regressions. */
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
  path.join(root, "packages/cloud/quint/generation_object_versions.qnt"),
);
const output = testOutputPath("quint-generation-object-versions");
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
    "packages/cloud/shared/src/db/repositories/__tests__/generation-object-versions.pglite.test.ts",
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
  `Generation object conformance failed: ${directory}`,
);
assert.equal(result.signal, null);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.tests, 8);
assert.equal(summary.executedTests, 8);
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
    "a failed SQL update preserves the old committed pointer and complete object",
    "parallel prepared writers retain their own bytes through later SQL publication",
    "all four fields publish new immutable keys without replacing prior payloads",
    "an ambiguous PUT leaves SQL authority and prior payloads unchanged",
    "a rejected immutable PUT cannot publish a new pointer",
    "late PUT settlement after a sibling failure cannot alter committed payloads",
    "explicit retained pointer restoration keeps its existing authority",
    "field offload retains complete content above the smaller immutable-helper ceiling",
  ].sort(),
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary }, null, 2)}\n`,
);
console.log(
  `Generation object conformance passed eight required tests. Evidence ${directory}`,
);
