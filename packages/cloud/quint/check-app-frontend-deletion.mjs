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
  path.join(root, "packages/cloud/quint/app_frontend_deletion.qnt"),
);
const postgres =
  process.env.APP_FRONTEND_DELETION_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert.ok(
  postgres,
  "Frontend conformance requires an isolated loopback qa_* PostgreSQL URL",
);
const output = testOutputPath("quint-app-frontend-deletion");
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
    file: "packages/cloud/shared/src/lib/services/__tests__/app-frontend-deletion.postgres.integration.test.ts",
    names: [
      "app deletion and rollback activation share the parent app lock",
      "a queued third activation cannot bypass the pending app deletion parent lock",
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
      env: {
        ...process.env,
        APP_FRONTEND_DELETION_TEST_POSTGRES_URL: postgres,
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
  `App frontend deletion conformance passed twenty-three PGlite and two PostgreSQL cases. Evidence ${directory}`,
);
