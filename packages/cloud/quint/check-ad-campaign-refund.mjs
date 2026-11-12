/** Strict real SQL checks for campaign deletion and refund publication. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/ad_campaign_refund.qnt"),
);
const postgres =
  process.env.AD_CAMPAIGN_REFUND_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert.ok(
  postgres,
  "Campaign refund conformance requires an isolated loopback qa_* PostgreSQL URL",
);
const output = testOutputPath("quint-ad-campaign-refund");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const suites = [
  {
    name: "pglite",
    file: "packages/cloud/shared/src/lib/services/advertising/campaign-deletion.pglite.test.ts",
    names: [
      "failed credit persistence keeps the campaign and its refundable allocation",
      "failed advertising ledger persistence rolls back the refund and campaign deletion",
      "successful campaign deletion links both financial receipts",
      "a post-commit cache failure leaves both receipts and cannot repeat the refund",
      "another organization cannot delete or refund this campaign",
      "a suppressed campaign deletion cannot claim success or refund credits",
      "a suppressed advertising receipt rolls back the campaign and refund",
      "a fully spent campaign deletes without fabricating a refund",
      ...[
        "credits_allocated",
        "credits_spent",
        "total_spend",
        "budget_amount",
      ].map(
        (field) => `a corrupt ${field} preserves the campaign and both ledgers`,
      ),
    ],
  },
  {
    name: "postgres",
    file: "packages/cloud/shared/src/lib/services/advertising/campaign-deletion.postgres.integration.test.ts",
    names: [
      "concurrent deletions publish one refund and one linked advertising receipt",
      "a spend committed while deletion waits is not refunded",
      "a waiting spend cannot modify a campaign after its refund commits",
      "a failed first ledger insert rolls back before the waiting delete retries",
    ],
  },
];
for (const suite of suites) {
  const report = path.join(directory, `${suite.name}.xml`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "180000",
      "--",
      "bun",
      "test",
      "--conditions=eliza-source",
      suite.file,
      "--timeout=120000",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    {
      cwd: root,
      env: { ...process.env, AD_CAMPAIGN_REFUND_TEST_POSTGRES_URL: postgres },
      encoding: "utf8",
      timeout: 200000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  await writeFile(
    path.join(directory, `${suite.name}.log`),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Campaign refund ${suite.name} checks failed: ${directory}`,
  );
  assert.equal(result.signal, null);
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.tests, suite.names.length);
  assert.equal(summary.executedTests, suite.names.length);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  const names = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase") names.push(tag.attributes.name);
  });
  parser.write(xml).close();
  assert.deepEqual(names.sort(), suite.names.sort());
  await writeFile(
    path.join(directory, `${suite.name}-results.json`),
    `${JSON.stringify({ status: "passed", names, summary }, null, 2)}\n`,
  );
}
console.log(
  `Campaign refund conformance passed twelve PGlite and four PostgreSQL cases. Evidence ${directory}`,
);
