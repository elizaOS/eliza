/** Real PostgreSQL conformance for job time authority in three process zones. */
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
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this uncached proof requires an isolated QA PostgreSQL database.
const databaseUrl = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert(
  databaseUrl,
  "Job time conformance requires INFERENCE_POLICY_TEST_POSTGRES_URL",
);
const parsed = new URL(databaseUrl);
assert(
  ["postgres:", "postgresql:"].includes(parsed.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
    parsed.username.startsWith("qa_"),
  "Job time conformance requires an isolated loopback qa_* PostgreSQL role with CREATEDB",
);
const output = testOutputPath("quint-job-time");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const testFile =
  "packages/cloud/shared/src/db/repositories/__tests__/job-time-authority.postgres.integration.test.ts";
const zones = ["UTC", "America/New_York", "Asia/Kathmandu"];
const expected = [
  ...zones.flatMap((zone) => [
    `${zone}: raw claimed timestamps match typed primary reads`,
    `${zone}: failed execution waits for its database backoff`,
    `${zone}: retryable outcomes accept the raw claim and preserve the attempt budget`,
  ]),
  "application clock skew cannot change a retry deadline",
  "a renewal blocked on its job lock starts its lease after the wait",
  "old generations cannot reschedule a successor after recovery",
  "terminal failure preserves the original microsecond schedule",
].sort();
const admin = new Client({ connectionString: databaseUrl });
let databaseName: string | undefined;
let failure: unknown;
let cancelled: NodeJS.Signals | undefined;
const results: unknown[] = [];
try {
  await admin.connect();
  const candidate = `quint_job_time_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${candidate}"`);
  databaseName = candidate;
  parsed.pathname = `/${databaseName}`;
  for (const [index, zone] of zones.entries()) {
    const report = path.join(directory, `${index}.xml`);
    const child = spawn(
      process.execPath,
      [
        path.join(root, "packages/scripts/run-with-deadline.ts"),
        "120000",
        "--",
        "bun",
        "test",
        "--conditions=eliza-source",
        "--timeout=30000",
        path.join(root, testFile),
        "--reporter=junit",
        `--reporter-outfile=${report}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TZ: zone,
          INFERENCE_POLICY_TEST_POSTGRES_URL: parsed.toString(),
        },
        stdio: "inherit",
      },
    );
    const forward = (signal: NodeJS.Signals) => {
      cancelled ??= signal;
      child.kill(signal);
    };
    const interrupt = () => forward("SIGINT"),
      terminate = () => forward("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    let outcome: { code: number | null; signal: NodeJS.Signals | null };
    try {
      outcome = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
    if (cancelled || outcome.signal) {
      cancelled ??= outcome.signal ?? undefined;
      break;
    }
    assert.equal(outcome.code, 0, `Job time checks failed in ${zone}`);
    const xml = await readFile(report, "utf8");
    const summary = parseJunitSummary(xml);
    assert.equal(
      summary.failures + summary.errors + summary.skipped,
      0,
      "Job time checks must all execute",
    );
    const names: string[] = [];
    const parser = new SaxesParser({ xmlns: false });
    parser.on("opentag", (tag) => {
      if (tag.name === "testcase") {
        const name = tag.attributes.name;
        assert(typeof name === "string");
        const leaf = name.split(" > ").at(-1);
        assert(leaf !== undefined);
        names.push(leaf);
      }
    });
    parser.write(xml).close();
    assert.deepEqual(names.sort(), expected);
    results.push({ zone, summary, report });
  }
} catch (error) {
  failure = error;
} finally {
  try {
    try {
      if (databaseName)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Job conformance and cleanup failed",
        )
      : error;
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
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Job time conformance passed all 39 PostgreSQL tests. Results ${directory}`,
);
