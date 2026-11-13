/** Check the existing Google provider suite for each declared Maps projection. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.basename(process.argv[2] ?? "");
assert(["MapsPlaceLookup.qnt", "MapsTileCache.qnt"].includes(model));
const lookup = model === "MapsPlaceLookup.qnt";
const label = lookup ? "place lookup" : "tile cache";
const output = testOutputPath(
  lookup ? "quint-maps-place-lookup" : "quint-maps-tile-cache",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
const outcomes = path.join(directory, "outcomes.json");
const result = spawnSync(
  "bun",
  [
    "--conditions=eliza-source",
    "test",
    "packages/cloud/api/__tests__/maps-google-provider.test.ts",
    `--test-name-pattern=${lookup ? "finite nearby lookup outcomes match the real HTTP provider" : "Google Map Tiles"}`,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ...(lookup ? { MAPS_PLACE_LOOKUP_EVIDENCE: outcomes } : {}),
    },
    encoding: "utf8",
    timeout: lookup ? 180_000 : 60_000,
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
  `Maps ${label} conformance failed: ${result.signal}`,
);
const summary = parseJunitSummary(await readFile(report, "utf8"));
assert.equal(summary.tests - summary.skipped, lookup ? 1 : 5);
assert.equal(summary.failures + summary.errors, 0);
if (lookup) {
  const rows = JSON.parse(await readFile(outcomes, "utf8"));
  assert.equal(rows.length, 64);
  const expected = [];
  for (const prefer of [false, true])
    for (const cancelled of [false, true])
      for (const nearby of ["place", "empty", "invalid", "outage"])
        for (const fallback of ["address", "empty", "invalid", "outage"])
          expected.push(JSON.stringify([prefer, cancelled, nearby, fallback]));
  assert.deepEqual(
    rows
      .map(({ prefer, cancelled, nearby, fallback }) =>
        JSON.stringify([prefer, cancelled, nearby, fallback]),
      )
      .sort(),
    expected.sort(),
  );
  for (const row of rows) {
    assert.equal(
      row.observed,
      row.cancelled
        ? "cancelled"
        : row.prefer && row.nearby !== "empty"
          ? row.nearby
          : row.fallback,
    );
    assert.equal(row.nearbyCalls, Number(!row.cancelled && row.prefer));
    assert.equal(
      row.geocodeCalls,
      Number(!row.cancelled && (!row.prefer || row.nearby === "empty")),
    );
  }
}
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ model, status: "passed", summary, report }, null, 2)}\n`,
);
console.log(`Maps ${label} conformance passed. Results ${directory}`);
