/** Run the existing real catalog contracts for the promoted-family projection. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const owner = path.join(root, "plugins/plugin-assistant");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "PromotedFamilyHints.qnt"),
);
const file = "src/services/message/calendar-discovery-family.contract.test.ts";
const required = [
  ...["Show my calendar events", "List the user calendar events"].map(
    (intent) =>
      `${intent} retains the complete parent rather than guessing filtered search`,
  ),
  ...[
    "Search my calendar for dentist",
    "Delete my calendar event",
    "What is my next calendar event?",
  ].map((intent) => `explicit operation remains narrow: ${intent}`),
  "Calendar umbrella hints its promoted family without overriding a precise operation",
  "standalone Calendar also keeps complete agenda contract for generic plural event wording",
  "omitted families are never synthesized outside the supplied authorized catalog",
  "already loaded feed stays callable beside a later generic context discovery",
  "the correction is domain-independent and still recognizes a specific operation suffix",
];
const output = testOutputPath("quint-promoted-family-hints");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "300000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    file,
    "--maxWorkers=1",
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: owner, encoding: "utf8" },
);
const log = path.join(directory, "vitest.log");
writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Catalog conformance interrupted: ${log}`);
assert.equal(result.status, 0, `Catalog conformance failed: ${log}`);
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(owner, file),
  required,
);
console.log(
  `Promoted-family conformance passed ${required.length} real catalog cases. ${report}`,
);
