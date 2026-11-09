/** Require actual SQL/Redis/KV handoff and cursor-recovery scenarios. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "packages/cloud/quint/StripeLegacyAdoption.qnt";
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const backendCases = (backend) => [
  backend === "kv"
    ? "read-only adoption reaches every legacy queue"
    : "persistent first-queue removal failure cannot starve later queues",
  "bounded adoption preserves backlog and same-call delivery",
  "foreign marker cannot discard original Stripe work",
  "mismatched retained payload remains unchanged",
  "unknown terminal digest cannot fabricate a matching receipt",
  "malformed prefix cannot starve valid work or leak raw data",
  "committed SQL with lost reply retains and safely replays raw",
  backend === "kv"
    ? "adoption never attempts destructive removal without a writer fence"
    : "lost remove acknowledgement cannot duplicate completed delivery",
  "identical retained copies share one delivery receipt",
  "cursor acknowledgement loss does not acknowledge work",
  "concurrent adopters retain one durable delivery per original",
  "slow first attempt cannot skip unattempted reserved entries",
  "lost progress completion reply is not work authority",
  "a missing historical receipt quarantines the original raw",
];
const suites = [
  {
    file: "packages/cloud/shared/src/lib/services/stripe-legacy-adoption.pglite.test.ts",
    required: [
      ...["kv", "redis"].flatMap((backend) =>
        backendCases(backend).map((name) => `${backend}: ${name}`),
      ),
      "stale completion cannot rewind a newer cursor reservation",
      "canonical migration loads the bounded adoption hint schema",
      "KV non-string values remain intact without starving valid raw entries",
      "KV adoption preserves an old-writer append without attempting removal",
      "matching marker, pending and completed receipts retain their original row identity",
      "retained KV receipt survives global cleanup without redelivery",
      "retained KV receipt survives provider cleanup without redelivery",
      "old unfiltered deletes preserve retained receipts and still return ordinary rows",
    ],
  },
  {
    file: "packages/cloud/shared/src/lib/services/stripe-delivery-outbox.pglite.test.ts",
    required: [
      "0555 adds the lease check without a validating scan under the exclusive lock",
      "a leased delivery is claimed once; an expired lease is claimed again and the old holder cannot settle",
      "a drain that dies after its claim leaves the delivery to the next drain, which completes it once",
      "retries back off, a spent budget dead-letters, and a resend makes it due with a fresh budget",
      "a delivery whose last attempt died is dead-lettered without running again",
      "retention never deletes undelivered work: cleanupOldEvents (the retention cron)",
      "retention never deletes undelivered work: cleanupOldEventsForProvider",
      "rows a drain claimed but did not reach inside its budget keep their attempts and are claimed at once",
      "matching legacy receipts are adopted and missing historical receipts remain quarantined",
      "a legacy entry that cannot be adopted stays listed and never blocks the outbox drain",
      "a delivered row drops the stored event, and a late legacy copy of it is not adopted again",
    ],
  },
  {
    file: "packages/cloud/shared/src/lib/services/stripe-legacy-adoption.postgres.integration.test.ts",
    required: [
      "PostgreSQL cursor selection waits and uses the winning locked hint",
      "PostgreSQL concurrent reservations fence stale progress completion",
      "PostgreSQL global cleanup waits for atomic legacy receipt retention",
      "PostgreSQL provider cleanup waits for atomic legacy receipt retention",
      "PostgreSQL old unfiltered cleanup waits for atomic legacy receipt retention",
      "PostgreSQL partial retention index skips retained legacy history",
    ],
  },
];
const output = testOutputPath("quint-stripe-legacy-adoption");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];
for (const [index, suite] of suites.entries()) {
  const report = path.join(directory, `${index}.xml`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "180000",
      "--",
      "bun",
      "test",
      "--isolate",
      "--conditions=eliza-source",
      suite.file,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(
    path.join(directory, `${index}.log`),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "Legacy adoption conformance interrupted");
  assert.equal(
    result.status,
    0,
    `Legacy adoption implementation check failed: ${suite.file}\n${result.stdout ?? ""}${result.stderr ?? ""}\nFull logs: ${directory}`,
  );
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.tests, suite.required.length);
  assert.equal(summary.executedTests, suite.required.length);
  assert.equal(summary.errors + summary.failures + summary.skipped, 0);
  const names = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase")
      names.push(String(tag.attributes.name).split(" > ").at(-1));
  });
  parser.write(xml).close();
  assert.deepEqual(
    names.sort(),
    [...suite.required].sort(),
    "Every required legacy-adoption scenario must execute",
  );
  results.push({ file: suite.file, names, summary, report });
}
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Stripe legacy adoption conformance passed ${suites.reduce((sum, suite) => sum + suite.required.length, 0)} scenarios. Results ${directory}`,
);
