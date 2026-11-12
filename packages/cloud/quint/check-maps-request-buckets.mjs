/** Require all real Maps SQLite admission and controlled-clock regression scenarios. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-maps-request-buckets");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
const result = spawnSync(
  "bun",
  [
    "--conditions=eliza-source",
    "test",
    "packages/cloud/api/__tests__/maps-request-allowance.miniflare.test.ts",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
await writeFile(path.join(directory, "tests.log"), log);
process.stdout.write(log);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  `Maps bucket conformance failed: ${result.signal}`,
);
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
    "Maps retains both refill boundaries through a clock rollback",
    "Maps retry delay includes the retained future refill boundary",
    "Maps durable allowance is shared, atomic, separately counted, and never replays admission",
    "Maps preserves burst AND sustained dimensions and refuses missing selected plan",
    "Maps retains original receipts and first outcomes across allowance windows",
    "Maps refuses malformed policy, expired windows, and credential revocation before admission",
    "Maps count and replay tombstones survive a Worker restart, without touching zero monetary funds",
    "Maps refuses corrupted storage and carries rate tokens across allowance resets",
    "Maps has its own limits when shared plan limits are off",
    "Maps requires selected burst and sustained configuration as well as an allowance",
  ].sort(),
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary, report }, null, 2)}\n`,
);
console.log(`Maps bucket conformance passed. Results ${directory}`);
