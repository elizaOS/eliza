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
      "failed app deletion must preserve frontend content when the retained app is reactivated",
      "a concurrent reactivation must not lose content before final deletion rejects the active app",
      "acknowledged app deletion removes frontend rows before their exact objects",
      "a lost committed app deletion reply retains objects without fabricating cleanup authority",
      "app deletion retains every manifest beyond the former thousand-row listing limit",
      "the final app deletion snapshot includes frontends published after deactivation",
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
  `App frontend deletion conformance passed six PGlite and two PostgreSQL cases. Evidence ${directory}`,
);
