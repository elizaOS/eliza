/** Check real checkout SQL, receipt matching and original provider-window recovery. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.ok(
  [
    "CreditCheckoutOrder.qnt",
    "LegacyCheckoutSettlement.qnt",
    "CreditCheckoutQuote.qnt",
  ].some(
    (model) =>
      path.resolve(root, process.argv[2] ?? "") ===
      path.join(root, "packages/cloud/quint", model),
  ),
  "Expected a checkout order or legacy settlement model",
);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: the conformance harness requires an isolated QA database.
const database = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert(
  database,
  "Set INFERENCE_POLICY_TEST_POSTGRES_URL to an isolated loopback qa_* PostgreSQL database; checkout conformance must run the lock test.",
);
const parsed = new URL(database);
assert(
  ["postgresql:", "postgres:"].includes(parsed.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
    parsed.username.startsWith("qa_"),
  "Checkout conformance requires an isolated loopback qa_* PostgreSQL role",
);
const base = testOutputPath("quint-credit-checkout-order");
mkdirSync(base, { recursive: true });
const output = mkdtempSync(path.join(base, "checks-"));
const checks = [
  {
    folder: "packages/cloud/shared",
    file: "src/lib/services/__tests__/stripe-checkout-orders.pglite.test.ts",
    names: [
      "reuses one tenant request and rejects a changed digest or user",
      "concurrent identical quote requests return the same durable winner",
      "concurrent conflicting quote requests cannot replace the winner",
      "the same quote request key is independent across organizations",
      "new orders are $5-$1,000 pay-as-you-go top-ups with no pack or bonus (#22963)",
      "grants exactly the charged amount as credits with no bonus",
      "concurrent webhook and landing verification converge on one grant",
      "a cache failure after commit preserves the original grant for replay",
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
      "a matching late Session acknowledgement preserves a webhook-settled order",
      "a different late Session acknowledgement cannot replace a settled receipt",
    ],
  },
  {
    folder: "packages/cloud/shared",
    file: "src/db/migrations/stripe-checkout-orders.test.ts",
    names: [
      "creates the authority shape and replays without changing it",
      "fails closed instead of accepting a colliding partial table",
      "enforces quote shape, tenant request uniqueness, and immutable transitions",
      "rejects cross-tenant ledger linkage and accepts one exact settlement",
      "rejects NULL payment-intent and metadata ledger bindings",
      "enforces and freezes the legacy quarantine user tenant binding",
    ],
  },
  {
    folder: "packages/cloud/shared",
    file: "src/db/migrations/stripe-checkout-provider-started-at.test.ts",
    names: [
      "0559 preserves unknown historical dispatch and enforces write-once new dispatch",
    ],
  },
  {
    folder: "packages/cloud/api",
    file: "__tests__/checkout-provider-horizon.pglite.test.ts",
    names: [
      "repeated failures at0/22/44h never reset the original23-hour creation cutoff",
      "a delayed first dispatch receives its own full original retry window",
      "first dispatch is timestamped by the primary despite an application clock ahead",
      "a slow application clock cannot authorize an expired ambiguous or started retry",
      "recovery searches the entire original retry window, including a late accepted retry",
      "legacy ambiguous orders remain read-only when original creation time is unknown",
      "legacy read-only discovery can recover an old Session outside the last-update window",
      "multiple matching historical Sessions require reconciliation instead of choosing one",
      "recovery follows later pages before binding the original Session",
      "a failed later lookup page cannot authorize another create",
      "competing matching Sessions on separate pages reject recovery",
      "an empty continuation page cannot authorize another create",
      "a repeated pagination cursor cannot authorize another create",
      "lookup deadline expiry cannot authorize another create",
      "a stale unbound reader adopts the customer already pinned by another caller",
      "a stale quoted caller can retry the same key after another caller dispatches",
    ],
  },
  {
    folder: "packages/cloud/shared",
    file: "src/db/migrations/stripe-checkout-legacy-lock.integration.test.ts",
    names: [
      "serializes quarantine insertion with user organization reassignment in both orders",
    ],
  },
];
const results = [];
for (const [index, { folder, file, names }] of checks.entries()) {
  const junit = path.join(output, `test-${index}.xml`);
  const child = spawnSync(
    "bun",
    [
      "--conditions=eliza-source",
      "test",
      file,
      "--timeout=120000",
      "--reporter=junit",
      `--reporter-outfile=${junit}`,
    ],
    {
      cwd: path.join(root, folder),
      encoding: "utf8",
      env: { ...process.env, APPS_TENANT_DB_TEST_DSN: parsed.toString() },
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(output, `test-${index}.log`),
    `${child.stdout ?? ""}${child.stderr ?? ""}`,
  );
  if (child.error) throw child.error;
  assert.equal(
    child.status,
    0,
    `Checkout conformance failed: ${file}; ${output}`,
  );
  const summary = parseJunitSummary(readFileSync(junit, "utf8"));
  assert.equal(
    summary.tests,
    names.length,
    `Unexpected checkout test inventory: ${file}`,
  );
  assert.equal(
    summary.executedTests,
    names.length,
    `Required checkout tests did not all execute: ${file}`,
  );
  const actualNames: string[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase") actualNames.push(String(tag.attributes.name));
  });
  parser.write(readFileSync(junit, "utf8")).close();
  assert.deepEqual(
    actualNames.sort(),
    [...names].sort(),
    `Required checkout test names changed: ${file}`,
  );
  assert.equal(summary.errors + summary.failures + summary.skipped, 0);
  results.push({ file, names, summary });
}
writeFileSync(
  path.join(output, "result.json"),
  `${JSON.stringify({ results, scope: "Concrete SQL, service and controlled-provider route schedules; not an exhaustive TypeScript refinement proof." }, null, 2)}\n`,
);
console.log(`Credit checkout order conformance passed: ${output}`);
