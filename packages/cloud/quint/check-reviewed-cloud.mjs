/** Run the named SQL and API regressions for newly imported cloud protocols. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = process.argv[2];
const suites = JSON.parse(
  await readFile(
    new URL("./reviewed-cloud-checks.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(process.argv.length, 3, "Select one reviewed cloud model");
assert.equal(
  path.resolve(root, model),
  path.join(root, "packages/cloud/quint", path.basename(model)),
);
const checks = suites[path.basename(model)];
assert(
  Array.isArray(checks) && checks.length > 0,
  "Unknown reviewed cloud model",
);
const output = testOutputPath(
  "quint-reviewed-cloud",
  path.basename(model, ".qnt"),
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];
let postgres;
let databaseName;
let childEnv = process.env;
let cancelled;
let failure;
try {
  if (path.basename(model) === "provisioning_execution.qnt") {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: the uncached conformance runner requires the same QA database as the other cloud hooks.
    const database = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
    assert(
      database,
      "Set INFERENCE_POLICY_TEST_POSTGRES_URL to an isolated loopback qa_* PostgreSQL database.",
    );
    const parsed = new URL(database);
    assert(
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
        parsed.username.startsWith("qa_"),
      "Provisioning conformance requires a loopback qa_* PostgreSQL role",
    );
    postgres = new Client({ connectionString: database });
    await postgres.connect();
    const candidate = `quint_provisioning_${randomUUID().replaceAll("-", "")}`;
    await postgres.query(`CREATE DATABASE "${candidate}"`);
    databaseName = candidate;
    parsed.pathname = `/${databaseName}`;
    childEnv = {
      ...process.env,
      DATABASE_URL: parsed.toString(),
      TEST_DATABASE_URL: parsed.toString(),
      INFERENCE_POLICY_TEST_POSTGRES_URL: parsed.toString(),
    };
  }
  for (const [index, check] of checks.entries()) {
    const report = path.join(directory, `${index}.xml`);
    const child = spawn(
      process.execPath,
      [
        path.join(root, "packages/scripts/run-with-deadline.ts"),
        "240000",
        "--",
        "bun",
        "test",
        "--conditions=eliza-source",
        check.file,
        "--max-concurrency=1",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
      ],
      { cwd: root, env: childEnv, stdio: "inherit" },
    );
    let interrupted;
    const forward = (signal) => {
      interrupted ??= signal;
      child.kill(signal);
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
    if (interrupted || result.signal) {
      cancelled = interrupted ?? result.signal;
      break;
    }
    assert.equal(
      result.code,
      0,
      `Implementation checks failed for ${check.file}`,
    );
    const xml = await readFile(report, "utf8");
    const summary = parseJunitSummary(xml);
    assert.equal(
      summary.failures + summary.errors + summary.skipped,
      0,
      "Required checks must pass without skips",
    );
    const names = [];
    const parser = new SaxesParser({ xmlns: false });
    parser.on("opentag", (tag) => {
      if (tag.name === "testcase") {
        assert.equal(
          typeof tag.attributes.name,
          "string",
          "A testcase needs its name",
        );
        names.push(tag.attributes.name.split(" > ").at(-1));
      }
    });
    parser.write(xml).close();
    assert.deepEqual(
      names.sort(),
      [...check.required].sort(),
      `Required checks changed for ${check.file}`,
    );
    results.push({ file: check.file, names, summary, report });
  }
} catch (error) {
  failure = error;
} finally {
  if (postgres) {
    try {
      try {
        if (databaseName)
          await postgres.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } finally {
        await postgres.end();
      }
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "Conformance and database cleanup failed",
          )
        : error;
    }
  }
}
if (cancelled) {
  if (failure) console.error(failure);
  process.kill(process.pid, cancelled);
  await new Promise(() => {});
}
if (failure) throw failure;
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ model, status: "passed", results }, null, 2)}\n`,
);
console.log(`Reviewed cloud conformance passed. Results ${directory}`);
