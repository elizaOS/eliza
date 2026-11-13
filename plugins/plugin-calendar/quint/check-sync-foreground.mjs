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
  path.join(import.meta.dirname, "CalendarSyncForeground.qnt"),
);

const output = testOutputPath("quint-calendar-sync-foreground");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const file = "test/linked-sync/sync-host.test.ts";
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
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
const log = path.join(directory, "vitest.log");
writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Calendar tests were interrupted: ${log}`);
assert.equal(result.status, 0, `Calendar tests failed: ${log}`);

const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(calendar, file),
  [
    ...[
      "reads only the exact four-field record and never treats damage as off",
      "matches only the same owner, organization, grant, calendar and agent",
      "retries a compare-and-exchange conflict and stops after the attempt limit",
      "offers a calendar only with safe provider semantics and verifiable names",
      "states failures and pass results in plain text",
    ].map((name) => `saved opt-in and target ${name}`),
    ...[
      "reviews, enables, syncs, lists links and pauses one exact destination",
      "serializes operations and reports the failure of a refused one",
      "never reuses an opt-in for a different agent, grant or calendar",
      "refuses a damaged record before any provider request",
      "grants the device opt-in before saving, and withdraws it when enabling fails",
      "asks for a new review when the device source or its opt-in changed",
    ].map((name) => `createCalendarSyncHost ${name}`),
    ...[
      "does not admit sync from a stopped registration's pending opt-in read",
      "retires a pending opt-in read when visibility leaves and returns",
      "does not publish a retired opt-in read failure over the new registration",
      "debounces local edits, defers one during a pass and stops in the background",
      "an owner change cancels, withdraws the device opt-in and resumes only a matching opt-in",
    ].map((name) => `foreground scheduling ${name}`),
  ],
);
console.log(`Passed ${checks.length} Calendar sync host cases. ${report}`);
