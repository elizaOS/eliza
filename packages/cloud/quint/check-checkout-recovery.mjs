/** Checks the Checkout models against real routes, SQL and migration guards. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.resolve(root, process.argv[2] ?? "");
const suites = new Map([
  [
    path.join(root, "packages/cloud/quint/checkout_credit_settlement.qnt"),
    [
      [
        "packages/cloud/shared/src/lib/services/__tests__/stripe-checkout-orders.pglite.test.ts",
        [
          "reuses one tenant request and rejects a changed digest or user",
          "new orders are $5-$1,000 pay-as-you-go top-ups with no pack or bonus (#22963)",
          "grants exactly the charged amount as credits with no bonus",
          "concurrent webhook and landing verification converge on one grant",
          "trusted webhook or verify receipts recover Session-create ACK loss exactly once",
          "webhook-first and verify-first ACK-loss receipts both settle and replay",
          "ACK-loss recovery rejects wrong client reference, metadata order, and Session races",
          "customer pinning accepts only the customer already published by authority",
          "fails closed on tenant, user, amount, currency, customer, session, and payment status",
          "conflicting payment-intent replay cannot reuse a settled order",
          "post-ledger failure rolls the grant back and a retry settles cleanly",
          "legacy custom cutover derives from paid cents and packs are durably quarantined",
          "legacy cutover rejects a cross-tenant user before grant or quarantine",
          "legacy pack quarantine accepts only an exact replay",
        ],
      ],
    ],
  ],
  [
    path.join(root, "packages/cloud/quint/checkout_retry_clock.qnt"),
    [
      [
        "packages/cloud/api/__tests__/checkout-provider-horizon.pglite.test.ts",
        [
          "repeated failures at0/22/44h never reset the original23-hour creation cutoff",
          "a delayed first dispatch receives its own full original retry window",
          "first dispatch is timestamped by the primary despite an application clock ahead",
          "a slow application clock cannot authorize an expired ambiguous or started retry",
          "recovery searches the entire original retry window, including a late accepted retry",
          "legacy ambiguous orders remain read-only when original creation time is unknown",
          "legacy read-only discovery can recover an old Session outside the last-update window",
          "multiple matching historical Sessions require reconciliation instead of choosing one",
        ],
      ],
      [
        "packages/cloud/shared/src/db/migrations/stripe-checkout-provider-started-at.test.ts",
        [
          "0559 preserves unknown historical dispatch and enforces write-once new dispatch",
        ],
      ],
    ],
  ],
]);
assert(suites.has(model), "Checkout conformance requires a supported model");
const output = testOutputPath("quint-checkout-recovery");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];
for (const [file, expected] of suites.get(model)) {
  const report = path.join(directory, `${results.length}.xml`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "240000",
      "--",
      "bun",
      "test",
      "--isolate",
      "--conditions=eliza-source",
      "--timeout=60000",
      path.join(root, file),
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(
    path.join(directory, `${results.length}.log`),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "Checkout conformance was interrupted");
  assert.equal(
    result.status,
    0,
    `Checkout implementation checks failed. See ${directory}`,
  );
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.tests, expected.length);
  assert.equal(summary.executedTests, expected.length);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  assert.equal(summary.files.length, 1);
  const names = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
    .map((match) =>
      match[1]
        .replaceAll("&apos;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&"),
    )
    .sort();
  assert.deepEqual(
    names,
    [...expected].sort(),
    "Every required Checkout test must execute",
  );
  results.push({ file, names, report });
}
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", model, results }, null, 2)}\n`,
);
console.log(`Checkout conformance passed. Results ${directory}`);
