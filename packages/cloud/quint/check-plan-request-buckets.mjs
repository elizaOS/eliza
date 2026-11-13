/** Check the real synchronous limiter and require every reviewed test name. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-plan-request-buckets");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
const result = spawnSync(
  "bun",
  [
    "--conditions=eliza-source",
    "test",
    "packages/cloud/shared/src/lib/services/plan-request-limiter.test.ts",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
await writeFile(path.join(directory, "tests.log"), log);
process.stdout.write(log);
if (result.error) throw result.error;
assert.equal(result.status, 0, `Limiter conformance failed: ${result.signal}`);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
const names = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name !== "testcase") return;
  assert.equal(typeof tag.attributes.name, "string");
  names.push(tag.attributes.name.split(" > ").at(-1));
});
parser.write(xml).close();
assert.deepEqual(
  names.sort(),
  [
    "a burst is refused until the burst bucket refills",
    "a wall-clock rollback cannot refill an already consumed interval",
    "burst preserves partial refill across a backward clock jump",
    "sustained preserves partial refill across a backward clock jump",
    "the sustained bucket refuses after the burst refills",
    "Maps and inference have separate buckets",
    "a plan's maps entry sets Maps limits apart from inference",
    "buckets are separate per user and per plan",
    "an unknown plan, a cache miss and an ended plan window use the default limits",
    "unset is off, `placeholder` is the unselected template, JSON is validated",
    "rollback refusal advertises a retry after the retained refill boundary",
    "429 carries the retry time in the body and in Retry-After",
  ].sort(),
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary, report }, null, 2)}\n`,
);
console.log(`Limiter conformance passed. Results ${directory}`);
