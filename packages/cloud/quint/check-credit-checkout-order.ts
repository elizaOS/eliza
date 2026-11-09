/** Check real checkout SQL, receipt matching and original provider-window recovery. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/CreditCheckoutOrder.qnt"),
);
const base = testOutputPath("quint-credit-checkout-order");
mkdirSync(base, { recursive: true });
const output = mkdtempSync(path.join(base, "checks-"));
const checks = [
  [
    "packages/cloud/shared",
    "src/lib/services/__tests__/stripe-checkout-orders.pglite.test.ts",
  ],
  ["packages/cloud/shared", "src/db/migrations/stripe-checkout-orders.test.ts"],
  [
    "packages/cloud/shared",
    "src/db/migrations/stripe-checkout-provider-started-at.test.ts",
  ],
  ["packages/cloud/api", "__tests__/checkout-provider-horizon.pglite.test.ts"],
];
const results = [];
for (const [index, [folder, file]] of checks.entries()) {
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
  assert.ok(summary.executedTests > 0, `No checkout tests executed: ${file}`);
  assert.equal(summary.errors + summary.failures + summary.skipped, 0);
  results.push({ file, summary });
}
writeFileSync(
  path.join(output, "result.json"),
  `${JSON.stringify({ results, scope: "Concrete SQL, service and controlled-provider route schedules; not an exhaustive TypeScript refinement proof." }, null, 2)}\n`,
);
console.log(`Credit checkout order conformance passed: ${output}`);
