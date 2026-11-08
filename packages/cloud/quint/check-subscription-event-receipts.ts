/** Require all named real PGlite receipt/publication checks, without skips. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "packages/cloud/quint/subscription_event_receipts.qnt";
assert(process.argv.length <= 3, "Select only the subscription event model");
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const suites = JSON.parse(
  await readFile(
    new URL("./reviewed-cloud-checks.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Array<{ file: string; required: string[] }>>;
const checks = suites[path.basename(model)];
assert(checks, "Subscription event checks are missing");
assert.deepEqual(
  checks.map((check) => check.file),
  [
    "packages/cloud/shared/src/db/repositories/subscription-billing-operations.pglite.test.ts",
    "packages/cloud/shared/src/db/repositories/subscription-lifecycle-finalization.pglite.test.ts",
  ],
);
assert.equal(
  checks.reduce((count, check) => count + check.required.length, 0),
  47,
);
process.argv[2] = model;
// Reuse the checked child deadline, signal forwarding, JUnit parser and exact
// case-name comparison. Import by URL so this hook has no second runner owner.
await import(new URL("./check-reviewed-cloud.mjs", import.meta.url).href);
