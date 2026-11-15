/** Require the real complete field and explicit preview regressions. */
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
  path.join(root, "packages/cloud/quint/object_field_hydration.qnt"),
);
const output = testOutputPath("quint-object-field-hydration");
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
    "packages/cloud/shared/src/db/repositories/__tests__/object-field-full-reads.pglite.test.ts",
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
assert.equal(result.status, 0, `Object field conformance failed: ${directory}`);
assert.equal(result.signal, null);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.tests, 16);
assert.equal(summary.executedTests, 16);
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
    "conversation content full read requires its complete object",
    "conversation api_request full read requires its complete object",
    "conversation api_response full read requires its complete object",
    "generation prompt full read requires its complete object",
    "generation negative_prompt full read requires its complete object",
    "generation result full read requires its complete object",
    "generation content full read requires its complete object",
    "agent event message full read requires its complete object",
    "agent event metadata full read requires its complete object",
    "SEO request prompt_context full read requires its complete object",
    "SEO provider call request_payload full read requires its complete object",
    "SEO provider call response_payload full read requires its complete object",
    "SEO artifact data full read requires its complete object",
    "full reads reject invalid pointer states and preserve provider failures",
    "empty full text is valid while malformed object JSON fails explicitly",
    "generation summary remains an explicit preview without object fetches",
  ].sort(),
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary }, null, 2)}\n`,
);
console.log(
  `Object field conformance passed sixteen required tests. Evidence ${directory}`,
);
