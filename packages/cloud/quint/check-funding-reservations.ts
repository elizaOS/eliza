/** Runs funding transaction and release cases on PGlite and real PostgreSQL. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(process.argv.length, 3, "Select the funding reservations model");
assert.equal(
  path.resolve(root, process.argv[2]),
  path.join(root, "packages/cloud/quint/subscription_funding_reservations.qnt"),
  "Funding conformance requires its own model",
);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: the uncached formal check uses an isolated QA database.
const databaseUrl = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert(
  databaseUrl,
  "Funding conformance requires INFERENCE_POLICY_TEST_POSTGRES_URL",
);
const parsed = new URL(databaseUrl);
assert(
  ["postgres:", "postgresql:"].includes(parsed.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
    parsed.username.startsWith("qa_"),
  "Funding conformance requires an isolated loopback qa_* PostgreSQL role with CREATEDB",
);
const suites = [
  {
    id: "transactions",
    file: "packages/cloud/shared/src/lib/services/subscription-funding-transaction.pglite.test.ts",
    expected: [
      "a rejected admission rolls back its real credit debit and funding reservation",
      "concurrent compute admissions reserve once, reject overspending, and replay without another debit",
      "a rejected mixed-source admission returns both paid allowance and purchased credit atomically",
      "work-completion failure rolls back the settlement and refund; exact replay never credits twice",
    ],
  },
  {
    id: "releases",
    file: "packages/cloud/shared/src/lib/services/subscription-allowance-lifecycle.pglite.test.ts",
    expected: [
      "an explicit cancellation is idempotent and releases allowance and cash once",
      "the expire job retires ended periods once and later settlements forfeit their remainder",
    ],
  },
];
const escapePattern = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const output = testOutputPath("quint-funding-reservations");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results: unknown[] = [];
let cancelled: NodeJS.Signals | undefined;

async function inspectCommittedAllocations(
  suite: string,
  url: string,
): Promise<void> {
  const inspection = new Client({ connectionString: url });
  try {
    await inspection.connect();
    const { rows } = await inspection.query<{
      reservations: number;
      terminal_allocations: number;
      bad_reservation_totals: number;
      bad_allocation_totals: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM billing_funding_reservations) AS reservations,
        (SELECT count(*)::integer FROM billing_funding_allocations a
          JOIN billing_funding_reservations r ON r.id=a.reservation_id
          WHERE r.status IN ('finalized','canceled')) AS terminal_allocations,
        (SELECT count(*)::integer FROM (
          SELECT r.id FROM billing_funding_reservations r
          LEFT JOIN billing_funding_allocations a ON a.reservation_id=r.id
          GROUP BY r.id
          HAVING COALESCE(sum(a.reserved_amount),0) <> r.requested_amount
            OR r.reserved_amount <> r.requested_amount
        ) bad) AS bad_reservation_totals,
        (SELECT count(*)::integer FROM billing_funding_allocations a
          JOIN billing_funding_reservations r ON r.id=a.reservation_id
          WHERE (r.status='reserved' AND
            (a.finalized_amount<>0 OR a.released_amount<>0 OR a.expired_refund_amount<>0))
          OR (r.status IN ('finalized','canceled') AND
            a.finalized_amount+a.released_amount+a.expired_refund_amount<>a.reserved_amount)
          OR (a.source='purchased_credit' AND a.expired_refund_amount<>0)
          OR (r.status='canceled' AND a.finalized_amount<>0)) AS bad_allocation_totals
    `);
    assert.equal(rows.length, 1);
    const result = rows[0];
    assert(
      result.reservations > 0 && result.terminal_allocations > 0,
      "Conservation check must observe committed and terminal records",
    );
    assert.equal(result.bad_reservation_totals, 0);
    assert.equal(result.bad_allocation_totals, 0);
    results.push({ suite, backend: "postgres", committedConservation: result });
  } finally {
    await inspection.end();
  }
}

async function run(
  suite: (typeof suites)[number],
  backend: "pglite" | "postgres",
  url?: string,
): Promise<void> {
  const { expected } = suite;
  const pattern = `(?:${expected.map(escapePattern).join("|")})$`;
  const report = path.join(directory, `${suite.id}-${backend}.xml`);
  const env = { ...process.env };
  // Only the selected transaction cases run. Never inherit a live SSH fixture.
  delete env.COMPUTE_FUNDING_SSH_FIXTURE;
  if (url) env.COMPUTE_FUNDING_POSTGRES_TEST_URL = url;
  else delete env.COMPUTE_FUNDING_POSTGRES_TEST_URL;
  const child = spawn(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "60000",
      "--",
      "bun",
      "test",
      "--conditions=eliza-source",
      path.join(root, suite.file),
      "--test-name-pattern",
      pattern,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  const forward = (signal: NodeJS.Signals) => {
    cancelled ??= signal;
    child.kill(signal);
  };
  const interrupt = () => forward("SIGINT"),
    terminate = () => forward("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  let outcome: { code: number | null; signal: NodeJS.Signals | null };
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  if (cancelled || outcome.signal) {
    cancelled ??= outcome.signal ?? undefined;
    return;
  }
  assert.equal(
    outcome.code,
    0,
    `Funding transaction checks failed on ${backend}`,
  );
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.failures + summary.errors, 0);
  assert.equal(summary.executedTests, expected.length);
  const cases: { name: string; skipped: boolean; failed: boolean }[] = [];
  let current: (typeof cases)[number] | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase") {
      const fullName = tag.attributes.name;
      assert(typeof fullName === "string");
      const name = fullName.split(" > ").at(-1);
      assert(name !== undefined);
      current = {
        name,
        skipped: false,
        failed: false,
      };
      cases.push(current);
    } else if (tag.name === "skipped" && current) current.skipped = true;
    else if ((tag.name === "failure" || tag.name === "error") && current)
      current.failed = true;
  });
  parser.on("closetag", (tag) => {
    if (tag.name === "testcase") current = undefined;
  });
  parser.write(xml).close();
  const selected = cases.filter((entry) => expected.includes(entry.name));
  assert.deepEqual(
    selected.map((entry) => entry.name),
    expected,
    "Cases must retain their shared fixture order",
  );
  assert(selected.every((entry) => !entry.skipped && !entry.failed));
  assert(
    cases.every((entry) => expected.includes(entry.name) || entry.skipped),
    "Unexpected funding case executed",
  );
  results.push({
    suite: suite.id,
    backend,
    selectedExecuted: selected.length,
    excludedSkipped: cases
      .filter((entry) => entry.skipped)
      .map((entry) => entry.name),
    summary,
    report,
  });
}

const admin = new Client({ connectionString: databaseUrl });
let databaseName: string | undefined;
let failure: unknown;
try {
  let connected = false;
  for (const suite of suites) {
    await run(suite, "pglite");
    if (cancelled) break;
    if (!connected) {
      await admin.connect();
      connected = true;
    }
    databaseName = `dedicated_compute_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    parsed.pathname = `/${databaseName}`;
    await run(suite, "postgres", parsed.toString());
    if (!cancelled)
      await inspectCommittedAllocations(suite.id, parsed.toString());
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    databaseName = undefined;
    if (cancelled) break;
  }
} catch (error) {
  failure = error;
} finally {
  try {
    try {
      if (databaseName)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Funding conformance and cleanup failed",
        )
      : error;
  }
}
if (cancelled) {
  if (failure) console.error(failure);
  process.kill(process.pid, cancelled);
  await new Promise(() => {});
}
if (failure) throw failure;
assert.equal(results.length, suites.length * 3);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Funding reservation conformance passed six selected cases on each backend. Results ${directory}`,
);
