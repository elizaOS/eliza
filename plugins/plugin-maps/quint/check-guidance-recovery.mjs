/** Actual screen/controller and geometric recovery cases over controlled provider/GPS ports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const models = ["MapsGuidanceRecovery.qnt", "MapsLocateRetirement.qnt"].map(
  (name) => path.join(import.meta.dirname, name),
);
assert(process.argv.length <= 3);
if (process.argv[2]) assert(models.includes(path.resolve(process.argv[2])));
const output = testOutputPath("quint-maps-guidance-recovery");
mkdirSync(output, { recursive: true });
const log = path.join(mkdtempSync(path.join(output, "run-")), "node-tests.tap");
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "180000",
    "--",
    process.execPath,
    "--test",
    "--experimental-transform-types",
    "--test-reporter=tap",
    "plugins/plugin-maps/test/guidance-client.test.mjs",
    "plugins/plugin-maps/test/maps-screen.test.mjs",
    "plugins/plugin-maps/test/navigation-client.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(log, text);
if (result.error) throw result.error;
assert.equal(result.signal, null, log);
assert.equal(result.status, 0, log);
const required = [
  "a maneuver that no fix came near is passed after two fixes clear beyond it",
  "a newer search, origin or Start retires a pending location request",
  "a location callback after the timeout cannot replace the retained origin",
  "a retired location cleanup failure cannot overwrite a newer accepted fix",
];
const observed = [...text.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
for (const title of required)
  assert.equal(
    observed.filter((name) => name === title).length,
    1,
    `Missing or duplicated ${title}: ${log}`,
  );
for (const receipt of ["# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"])
  assert(text.split(/\r?\n/).includes(receipt), log);
assert(observed.length >= required.length, log);
console.log(
  `Maps guidance/location conformance passed ${observed.length} real-source cases. Report ${log}`,
);
