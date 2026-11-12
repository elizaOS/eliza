/**
 * Require every named platform subscription command scenario against migrated
 * PGlite: the command repository, the mobile checkout return, and the recovery
 * sweep's read-back and closure lanes with a loopback Stripe.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const commandModel = "packages/cloud/quint/PlatformSubscriptionCommand.qnt";
const readBackModel = "packages/cloud/quint/SubscriptionCheckoutReadBack.qnt";
const checkoutRecovery =
  "packages/cloud/shared/src/lib/services/subscription-checkout-recovery.pglite.test.ts";
const suites = new Map<string, Array<[file: string, required: string[]]>>([
  [
    commandModel,
    [
      [
        "packages/cloud/shared/src/db/repositories/subscription-billing-operations.pglite.test.ts",
        [
          "accepts exact command replay and rejects digest or tenant divergence",
          "fences provider dispatch as outcome-unknown and resolves it with revision CAS",
          "platform command dispatch refuses stale or foreign authority and preserves its first fence",
          "platform command failure replay requires the original generation and exact terminal evidence",
          "platform command supersession retires only a prepared intent with exact replay",
          "platform checkout application requires matching retained history and replays only its original result",
          "platform cancel and resume require their dedicated dispatch protocol",
          "platform command original provider identity is protected by the database",
        ],
      ],
      [
        checkoutRecovery,
        [
          "mobile checkout is a hosted page that returns to the registered native billing return",
          "mobile checkout refuses a missing or malformed return before any provider write",
          "a stored mobile contract returns only to one billing return with the fixed query",
          "checkout contracts bind return behavior to their presentation",
        ],
      ],
    ],
  ],
  [
    readBackModel,
    [
      [
        checkoutRecovery,
        [
          "a still-open checkout is read back with a doubling, capped backoff",
          "abandoned open checkouts cannot crowd out fenced or provider-expired ones, or each other's lane",
          "recovery reads a dispatched checkout back within minutes so a paid session is settled without its webhook",
          "recovery settles provider-expired checkouts and closes payable sessions of fenced organizations",
          "a dispatched checkout with no session after its provider deadline fails as expired",
        ],
      ],
      [
        "packages/cloud/shared/src/db/repositories/subscription-paid-renewal-recovery.pglite.test.ts",
        [
          "the recovery sweep entitles a paid checkout whose webhook never arrived",
          "the sweep, the app's confirm and the webhook settle one paid checkout exactly once",
        ],
      ],
    ],
  ],
]);
assert(process.argv.length <= 3, "Select only one subscription command model");
const model = path
  .relative(root, path.resolve(root, process.argv[2] ?? commandModel))
  .split(path.sep)
  .join("/");
const selected = suites.get(model);
assert(selected, "Subscription command conformance requires a supported model");
const output = testOutputPath("quint-platform-subscription-command");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];
for (const [index, [file, required]] of selected.entries()) {
  const report = path.join(directory, `${index}.xml`);
  const pattern = required
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "240000",
      "--",
      "bun",
      "test",
      "--isolate",
      "--conditions=eliza-source",
      "--timeout=180000",
      path.join(root, file),
      "--test-name-pattern",
      pattern,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(
    path.join(directory, `${index}.log`),
    `${child.stdout ?? ""}${child.stderr ?? ""}`,
  );
  if (child.error) throw child.error;
  assert.equal(
    child.signal,
    null,
    "Subscription command conformance was interrupted",
  );
  assert.equal(
    child.status,
    0,
    `Subscription command checks failed for ${file}. See ${directory}`,
  );
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.executedTests, required.length);
  assert.equal(summary.failures + summary.errors, 0);
  assert.equal(summary.files.length, 1);
  const names: string[] = [];
  const excluded: string[] = [];
  let current: { name: string; skipped: boolean } | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase") {
      assert.equal(
        typeof tag.attributes.name,
        "string",
        "A testcase needs its name",
      );
      current = {
        name: String(tag.attributes.name).split(" > ").at(-1) ?? "",
        skipped: false,
      };
    } else if (tag.name === "skipped" && current) current.skipped = true;
  });
  parser.on("closetag", (tag) => {
    if (tag.name !== "testcase") return;
    assert(current, "A testcase must have an opening tag");
    (current.skipped ? excluded : names).push(current.name);
    current = undefined;
  });
  parser.write(xml).close();
  // Bun includes unrelated, pattern-excluded tests in JUnit. Every selected
  // contract scenario must execute; a skipped required case never counts as proof.
  assert.equal(summary.tests, names.length + excluded.length);
  assert.equal(summary.skipped, excluded.length);
  assert(
    excluded.every((name) => !required.includes(name)),
    "A required command scenario was skipped",
  );
  assert.deepEqual(
    names.sort(),
    [...required].sort(),
    "Every required command scenario must execute",
  );
  results.push({ file, names, excluded, summary, report });
}
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", model, results }, null, 2)}\n`,
);
console.log(
  `Subscription command conformance passed ${results.reduce((count, result) => count + result.names.length, 0)} scenarios for ${model}. Results ${directory}`,
);
