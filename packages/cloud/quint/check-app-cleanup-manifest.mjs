/** Strict real SQL conformance for frontend publication and cleanup authority. */
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
  path.join(root, "packages/cloud/quint/app_cleanup_manifest.qnt"),
);
const postgres =
  process.env.APP_DELETION_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert.ok(
  postgres,
  "Frontend conformance requires an isolated loopback qa_* PostgreSQL URL",
);
const output = testOutputPath("quint-app-cleanup-manifest");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const suites = [
  {
    name: "pglite",
    file: "packages/cloud/shared/src/lib/services/__tests__/app-frontend-deletion.pglite.test.ts",
    names: [
      "failed app deletion retains frontend content behind the permanent deletion fence",
      "a concurrent reactivation is rejected before original-job final deletion",
      "acknowledged app deletion removes frontend rows before their exact objects",
      "a lost committed app deletion reply retains objects without fabricating cleanup authority",
      "app deletion retains every manifest beyond the former thousand-row listing limit",
      "the final app deletion snapshot includes frontends published before the permanent fence",
      "failed artifact deletion retains the complete original cleanup plan and resumes after cascade",
      "lost final SQL acknowledgement recovers exact original artifacts from the retained job",
      "an acknowledged object prefix is not deleted again after a later object fails",
      "unconfirmed marked cleanup blocks job removal and account provider completion after app cascade",
      "historical version-one jobs without cleanup manifests do not become permanent account blockers",
      "suppressed object acknowledgement keeps the cursor unchanged and retries only its original key",
      "the complete manifest remains inline above the ordinary object-offload ceiling",
      "the immutable cleanup plan and confirmed receipt cannot be replaced or rewound",
      "a bounded cleanup invocation retains pending status and resets retry budget only after durable progress",
      "a locked pending empty draft retires without inventing any uploaded artifacts",
      "an ambiguous legacy failed empty draft remains explicitly recovery-required",
      "deletion waits for the original paused uploader and then cleans its complete planned keys",
      "an unknown PUT outcome retains upload authority and prevents a false cleanup receipt",
      "invalid bundle validation performs no partial upload or orphan draft creation",
      "cleanup authority rejects missing or non-typed digest count and confirmation fields",
      "suppressed writer quiescence cannot publish or authorize app cleanup",
      "started and failed upload rows cannot regain unstarted deletion authority",
    ],
  },
  {
    name: "postgres",
    file: "packages/cloud/shared/src/lib/services/__tests__/app-deletion-authority.postgres.integration.test.ts",
    names: [
      "a queued cross-organization mobile issuance is included by the stable key-set recheck",
      "revocation waiting on a deletion shares policy order and exact replay opens no new permits",
      "post-lock lease expiry uses naive UTC authority in UTC",
      "post-lock lease expiry uses naive UTC authority in America/New_York",
      "post-lock lease expiry uses naive UTC authority in Asia/Kathmandu",
      "competing cleanup acknowledgements advance one original cursor and retain the organization",
      "cleanup acknowledgement rejects a lease that expires during its job lock wait in UTC",
      "cleanup acknowledgement rejects a lease that expires during its job lock wait in America/New_York",
      "cleanup acknowledgement rejects a lease that expires during its job lock wait in Asia/Kathmandu",
      "a paused PostgreSQL uploader retains its full plan until deletion admission stops and quiesces it",
    ],
  },
  {
    name: "ui",
    file: "packages/ui/src/cloud/applications/lib/__e2e__/app-deletion-pending.test.tsx",
    names: [
      "bulk deleting rows stay visible with pending status and disabled mutations until exact HTTP receipts complete",
      "settings disable save and key regeneration while the original deletion receipt is pending",
      "a second row cannot replace an active deletion batch and duplicate confirmation sends only one request",
      "a list refetch cannot hide pending cleanup rows before their original receipt",
      "a late deletion receipt after an authority switch cannot publish into the next session",
      "a completed batch cannot run its delayed cache refresh after an authority change",
    ],
  },
  {
    name: "ui-page",
    file: "packages/ui/src/cloud/applications/lib/__e2e__/app-deletion-page.test.tsx",
    names: [
      "the actual page retains pending rows through an empty scoped refetch and drops them at an organization switch",
      "the actual page removes a confirmed deletion from its authenticated cache despite a stale list response",
    ],
  },
  {
    name: "ui-detail",
    file: "packages/ui/src/cloud/applications/lib/__e2e__/app-deletion-detail.test.tsx",
    names: [
      "actual detail page preserves pending deletion through principal",
      "actual detail page preserves pending deletion through organization",
      "actual detail page preserves pending deletion through missing-metadata",
    ],
  },
  {
    name: "ui-recovery",
    file: "packages/ui/src/cloud/applications/lib/__e2e__/app-deletion-recovery.test.tsx",
    names: [
      "detail retains the original deletion after transport and resumes with GET only",
      "detail retains the original deletion after unconfirmed and resumes with GET only",
      "detail retains the original deletion after recovery and resumes with GET only",
      "table retains the original deletion after transport and resumes with GET only",
      "table retains the original deletion after unconfirmed and resumes with GET only",
      "table retains the original deletion after recovery and resumes with GET only",
      "detail keeps ordinary admission rejection separate from pending jobs",
      "table keeps ordinary admission rejection separate from pending jobs",
    ],
  },

  {
    name: "ui-client",
    file: "packages/ui/src/cloud/applications/lib/__e2e__/app-deletion-client.test.ts",
    names: [
      "the app helper waits for the original job receipt before reporting success",
      "an acknowledged complete replay needs no additional request",
      "a completed job with a different app receipt is rejected",
      "legacy success false is not cast into a successful app deletion",
      "cancelling the wait never sends a job cancellation or another DELETE",
      "poll timeout stops only the client wait",
      "a failed job never reports app deletion success",
      "a cancelled job never reports app deletion success",
      "a completed job without cleanup confirmation undefined remains pending",
      "a completed job without cleanup confirmation false remains pending",
      "lost status observation retains original identity and resumes with GET only",
      "a status deadline retains the original job for read-only recovery",
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
      ...(suite.name.startsWith("ui")
        ? [
            "x",
            "vitest",
            "run",
            "--config",
            "./vitest.config.ts",
            path.relative(
              path.join(root, "packages/ui"),
              path.join(root, suite.file),
            ),
            "--reporter=junit",
            `--outputFile=${report}`,
          ]
        : [
            "test",
            "--conditions=eliza-source",
            suite.file,
            "--timeout=120000",
            "--reporter=junit",
            `--reporter-outfile=${report}`,
          ]),
    ],
    {
      cwd: suite.name.startsWith("ui") ? path.join(root, "packages/ui") : root,
      env: {
        ...process.env,
        APP_DELETION_TEST_POSTGRES_URL: postgres,
      },
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
    `Frontend ${suite.name} conformance failed: ${directory}`,
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
  `App frontend deletion conformance passed twenty-three PGlite, ten PostgreSQL and eight UI cases. Evidence ${directory}`,
);
