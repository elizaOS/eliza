/** Require the maintained desktop host retention cases and their receipts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(process.argv.length, 3);
assert.equal(
  path.resolve(root, process.argv[2]),
  path.join(root, "packages/app/quint/DesktopDynamicViewRetention.qnt"),
);
const output = testOutputPath("quint-desktop-view-retention");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const junit = path.join(directory, "electrobun.xml");
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "120000",
    "--",
    "bun",
    "run",
    "--cwd",
    "packages/app/platforms/electrobun",
    "test",
    "src/dynamic-views/session-retention.test.ts",
    "--reporter=junit",
    `--outputFile=${junit}`,
  ],
  { cwd: root, encoding: "utf8" },
);
const log = path.join(directory, "electrobun.log");
writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Host retention terminated. Receipt ${log}`);
assert.equal(result.status, 0, `Host retention failed. Receipt ${log}`);

const xml = readFileSync(junit, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
const expected = [
  "an open kiosk session stays addressable beyond the default history target",
  "history pruning waits for close receipts and trims multiple retired sessions",
];
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
  expected,
  `Incomplete host retention cases: ${junit}`,
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ names, summary, junit, log }, null, 2)}\n`,
);
console.log(
  `Desktop dynamic view retention passed both host cases. Receipt ${junit}`,
);
