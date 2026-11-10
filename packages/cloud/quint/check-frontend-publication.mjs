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
  path.join(root, "packages/cloud/quint/frontend_publication.qnt"),
);
const postgres =
  process.env.FRONTEND_PUBLICATION_TEST_POSTGRES_URL ??
  process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert.ok(
  postgres,
  "Frontend conformance requires an isolated loopback qa_* PostgreSQL URL",
);
const output = testOutputPath("quint-frontend-publication");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const suites = [
  {
    name: "pglite",
    file: "packages/cloud/shared/src/lib/services/__tests__/frontend-publication.pglite.test.ts",
    names: [
      "complete frontend publication retains every manifest object and serves it",
      "a foreign organization cannot activate a published deployment",
      "a foreign organization cannot create an upload or write its objects",
      "upload and quiescence guards bind both the parent app and organization",
      "a lost finalization acknowledgement preserves the published row and all objects",
      "activation before a lost finalization reply cannot be undone by upload cleanup",
      "a proven unpublished failure retires the row before removing its objects",
      "a lost failure receipt retains objects instead of assuming retirement committed",
      "deletion before finalization cannot report a successful deployment",
      "a repeated finalization cannot replace an active deployment manifest",
      "failed publication cleanup never changes a ready deployment to failed",
      "deletion after publication cannot fall back to the original pending row",
      "a lost activation reply recovers the active deployment from primary SQL",
    ],
  },
  {
    name: "postgres",
    file: "packages/cloud/shared/src/lib/services/__tests__/frontend-publication.postgres.integration.test.ts",
    names: [
      "ownership changed while creation waits cannot allocate a deployment",
      "acknowledged publication wins a waiting retirement and keeps its manifest",
      "acknowledged retirement wins a waiting publication and cannot be revived",
      "activation wins a waiting deletion without losing the active deployment",
      "deletion wins a waiting activation and rolls back the old active demotion",
      "a lost finalization acknowledgement cannot delete PostgreSQL-published active objects",
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
      env: { ...process.env, FRONTEND_PUBLICATION_TEST_POSTGRES_URL: postgres },
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
  `Frontend publication conformance passed eleven PGlite and five PostgreSQL cases. Evidence ${directory}`,
);
