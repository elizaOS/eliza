/** Require the real document graph transaction and HTTP boundary regressions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/document_publication.qnt"),
);
const output = testOutputPath("quint-document-publication");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const originalNames = [
  "document publication retains complete text and every ordered fragment",
  "fragment failure rolls back the parent and the whole fragment batch",
  "parent deletion failure rolls back fragment deletion through the real route",
  "a suppressed parent deletion rolls back fragment deletion through the real route",
  "document deletion removes its whole graph and a second request reports absence",
  "a foreign document scope cannot delete the parent or its fragments",
];
const interleavingNames = [
  "PostgreSQL publication stays invisible and a concurrent delete linearizes before commit",
  "PostgreSQL failed publication exposes no partial graph and permits a complete retry",
  "PostgreSQL concurrent HTTP deletes serialize on the parent and commit one complete removal",
  "PostgreSQL a waiting delete recovers the whole graph after the first transaction rolls back",
];
const results = [];
async function run(mode, file, expected, env) {
  const report = path.join(directory, `${mode}.xml`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "240000",
      "--",
      "bun",
      "test",
      "--isolate",
      "--conditions=eliza-source",
      file,
      "--max-concurrency=1",
      "--timeout=120000",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 260000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  await writeFile(
    path.join(directory, `${mode}.log`),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Document ${mode} conformance failed: ${directory}`,
  );
  assert.equal(result.signal, null);
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.tests, expected.length);
  assert.equal(summary.executedTests, expected.length);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  const names = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase") names.push(tag.attributes.name);
  });
  parser.write(xml).close();
  assert.deepEqual(names.sort(), [...expected].sort());
  results.push({ mode, file, names, summary, report });
}

// Require a disposable local QA authority, never a production connection.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: the canonical conformance runner supplies an isolated QA server.
const database = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert(
  database,
  "Set INFERENCE_POLICY_TEST_POSTGRES_URL to an isolated loopback qa_* PostgreSQL role",
);
const parsed = new URL(database);
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
    parsed.username.startsWith("qa_"),
  "Document conformance requires an isolated loopback qa_* PostgreSQL role",
);
const { Client } = createRequire(
  new URL("../shared/package.json", import.meta.url),
)("pg");
const administrator = new Client({ connectionString: database });
let name;
let server;
let failure;
try {
  const pgliteEnv = { ...process.env };
  delete pgliteEnv.DOCUMENT_PUBLICATION_TEST_POSTGRES_URL;
  await run(
    "pglite",
    "packages/cloud/api/__tests__/documents-publication-atomicity.pglite.test.ts",
    originalNames,
    pgliteEnv,
  );
  await administrator.connect();
  server = (
    await administrator.query(
      "SELECT current_user AS role, current_setting('server_version') AS version",
    )
  ).rows[0];
  assert(
    server.role.startsWith("qa_"),
    "The connected role must be a QA authority",
  );
  const candidate = `quint_document_${randomUUID().replaceAll("-", "")}`;
  await administrator.query(`CREATE DATABASE "${candidate}"`);
  name = candidate;
  await administrator.query(
    `ALTER DATABASE "${name}" SET default_transaction_isolation='read committed'`,
  );
  parsed.pathname = `/${name}`;
  parsed.searchParams.delete("options");
  await run(
    "postgres",
    "packages/cloud/api/__tests__/documents-publication.postgres.integration.test.ts",
    [...originalNames, ...interleavingNames],
    {
      ...process.env,
      DOCUMENT_PUBLICATION_TEST_POSTGRES_URL: parsed.toString(),
    },
  );
} catch (error) {
  failure = error;
} finally {
  try {
    if (name) await administrator.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Document checks and database cleanup failed",
        )
      : error;
  }
  try {
    await administrator.end();
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Document checks and connection cleanup failed",
        )
      : error;
  }
}
if (failure) throw failure;
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", server, results }, null, 2)}\n`,
);
console.log(
  `Document publication conformance passed six PGlite and ten PostgreSQL tests. Evidence ${directory}`,
);
