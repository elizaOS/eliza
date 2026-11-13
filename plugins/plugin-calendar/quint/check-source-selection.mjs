import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const calendar = path.resolve(import.meta.dirname, "..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "CalendarSourceSelection.qnt"),
);

const output = testOutputPath("quint-calendar-source-selection");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const suites = [
  {
    file: "src/service/feed-preferences.test.ts",
    suite: "calendar feed preference SQL revisions",
    names: [
      "upgrades an existing preference table with the nonnegative version constraint",
      "migrates the two-field cache value once without leaving cache authoritative",
      "allows exactly one cross-runtime write for the same listed version",
      "returns a true no-op without consuming the selection version or touching ICS",
      "keeps delimiter collisions and provider/account aliases independent",
      "rejects an aliased ICS namespace before it can create a preference row",
      "follows a host default only until the owner first changes the source",
      "keeps an earlier seed for sources whose host declares no default",
      "rejects a stale no-op instead of accepting an obsolete UI token",
      "rolls back preference and ICS provider rows when the provider step fails",
    ],
  },
  {
    file: "src/source-administration/adapter.test.ts",
    suite: "calendar source administration adapter",
    names: [
      "preserves unavailable identities when catalog discovery has no usable rows",
      "uses the listed selection snapshots without reading each preference again",
      "rejects a stale selection version before attempting a write",
      "propagates failed discovery without treating it as an empty source list",
      "preserves the durable conflict check when selection changes after listing",
      "preserves unavailable discovery as health-only unselectable sources",
      "keeps same-named primary calendars distinct by exact account and grant",
      "preserves a disconnected health-only identity as unselectable",
      "updates only the exact listed identity and returns a revision receipt",
      "commits ICS provider enablement and selection version atomically",
      "propagates an explicit atomic failure without manufacturing a receipt",
      "rejects an identity whose account field was altered after listing",
    ],
  },
];

for (const { file, suite, names } of suites) {
  const label = path.basename(path.dirname(file));
  const report = path.join(directory, `${label}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "180000",
      "--",
      process.execPath,
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.config.ts",
      file,
      "--maxWorkers=1",
      "--cache=false",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: calendar, encoding: "utf8" },
  );
  const log = path.join(directory, `${label}.log`);
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    `Calendar selection suite interrupted: ${log}`,
  );
  assert.equal(result.status, 0, `Calendar selection suite failed: ${log}`);
  requireVitestConformance(
    JSON.parse(readFileSync(report, "utf8")),
    path.join(calendar, file),
    names.map((name) => `${suite} ${name}`),
  );
  console.log(`Passed ${names.length} Calendar ${label} cases. ${report}`);
}
