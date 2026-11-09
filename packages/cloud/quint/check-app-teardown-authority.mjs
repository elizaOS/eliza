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
  path.join(root, "packages/cloud/quint/app_teardown_authority.qnt"),
);
const postgres =
  process.env.APP_DELETION_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert.ok(
  postgres,
  "App teardown conformance requires an isolated loopback qa_* PostgreSQL URL",
);
const output = testOutputPath("quint-app-teardown-authority");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const suites = [
  {
    name: "admission",
    file: "packages/cloud/shared/src/lib/services/__tests__/app-deletion-admission.pglite.test.ts",
    names: [
      "admission binds one original job and revokes mobile credentials in the same transaction",
      "the permanent deletion binding rejects ordinary and direct SQL reactivation",
      "a retry cannot change the original deletion options or job payload",
      "foreign organization admission creates no operation and does not fence the app",
      "credential revocation failure rolls back the job and permanent app fence",
      "an inconsistent ordinary app key cannot revoke another organization's credential",
      "suppressed credential retirement rolls back deletion admission",
      "suppressed grant retirement rolls back deletion admission",
    ],
  },
  {
    name: "lifecycle",
    file: "packages/cloud/shared/src/lib/services/__tests__/app-deletion-lifecycle.pglite.test.ts",
    names: [
      "the actual DELETE route returns 202 until the original root has a confirmed completion receipt",
      "foreign and invalid DELETE requests cannot create a root or revoke the app",
      "public job status and failure receipts never expose the retained database URI",
      "a retry with different deletion options conflicts without another root",
      "original database child confirmation releases capacity once and gates the final cascade",
      "a provider DROP with a lost response is recoverable without double releasing capacity",
      "a changed cluster or expired child lease cannot dispatch an original database DROP",
      "receipt write failure rolls back both placement release and capacity decrement",
      "container teardown confirms the captured Docker identity and node before the app can disappear",
      "a backend for a different node cannot falsely confirm container removal",
      "unconfirmed legacy containers and direct app deletion remain fenced",
      "a GitHub dispatch with an unknown outcome is never repeated or treated as successful",
      "original job replay after ownership changes remains a read without another policy mutation",
      "a legacy deleted container status is not accepted without original provider identity",
      "suppressed resource-plan publication rolls back child creation before dispatch",
      "suppressed GitHub dispatch publication cannot authorize a provider DELETE",
      "suppressed final completion receipt retains the original app",
      "failed revocation delivery blocks teardown and original replay retries the same targets",
      "a complete credential list above the normal offload ceiling remains replayable inline",
      "a known other-app offloaded job does not block original app teardown",
      "a job target changed after full restoration cannot pass final quiescence",
      "suppressed GitHub completion receipt retains an explicit operator recovery state",
      "the real apps worker completes the API's original deletion job before success replay",
      "completed deletion replay does not depend on the current revocation gate",
      "app deletion receipt guards do not freeze unrelated job result fields",
      "public job status omits the retained private frontend cleanup manifest",
      "the DELETE route stays pending after metadata cascade until original artifact cleanup is acknowledged",
      "suppressed database placement write rolls back capacity release",
      "suppressed database receipt write rolls back capacity release",
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
      "a paused PostgreSQL uploader retains its full plan until deletion admission stops and quiesces it",
      "cleanup acknowledgement rejects a lease that expires during its job lock wait in UTC",
      "cleanup acknowledgement rejects a lease that expires during its job lock wait in America/New_York",
      "cleanup acknowledgement rejects a lease that expires during its job lock wait in Asia/Kathmandu",
    ],
  },
  {
    name: "ui",
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
      ...(suite.name === "ui"
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
      cwd: suite.name === "ui" ? path.join(root, "packages/ui") : root,
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
    `App teardown ${suite.name} conformance failed: ${directory}`,
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
  `App teardown conformance passed strict admission, lifecycle, PostgreSQL and UI cases. Evidence ${directory}`,
);
