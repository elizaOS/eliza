/** Requires production timer and immediate request delivery with local HTTPS and PGlite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const testFiles = [
  "packages/auth/test/login/webhook-timer.integration.test.ts",
  "packages/auth/test/login/request-webhook.integration.test.ts",
];
const output = testOutputPath("quint-auth-webhook-timer");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
const run = spawnSync(
  "bun",
  [
    "--conditions=eliza-source",
    "test",
    "--isolate",
    ...testFiles,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
);
if (run.error) throw run.error;
if (run.signal) process.kill(process.pid, run.signal);
assert.equal(run.status, 0, `Login webhook timer failed. See ${directory}`);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
const names = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name === "testcase") names.push(tag.attributes.name);
});
parser.write(xml).close();
assert.deepEqual(names.sort(), [
  "detaching the task adapter preserves login delivery and shutdown commits its receipt",
  "login shutdown drains a failed delivery and leaves the next claim for restart",
  "shutdown retains request webhook siblings through a configuration failure",
]);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary, report }, null, 2)}\n`,
);
console.log(
  `Login webhook timer conformance passed ${names.length} cases. Evidence ${directory}`,
);
