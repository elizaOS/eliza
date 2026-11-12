/** Check job leases against real PostgreSQL transaction interleavings. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: the uncached Quint conformance runner requires an isolated QA database.
const database = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
assert(
  database,
  "Set INFERENCE_POLICY_TEST_POSTGRES_URL to an isolated loopback qa_* PostgreSQL database. See packages/cloud/quint/README.md.",
);
const parsed = new URL(database);
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
    parsed.username.startsWith("qa_"),
  "Job execution lease conformance requires an isolated loopback qa_* PostgreSQL role",
);
const output = testOutputPath("quint-job-execution-lease");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];

async function run(file, names) {
  const report = path.join(directory, `${results.length}.xml`);
  const child = spawn(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "240000",
      "--",
      "bun",
      "test",
      "--isolate",
      "--conditions=eliza-source",
      path.join(root, file),
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: root, env: process.env, stdio: "inherit" },
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
  if (interrupted || result.signal)
    process.kill(process.pid, interrupted ?? result.signal);
  assert.equal(
    result.code,
    0,
    `Job execution lease implementation checks failed for ${file}`,
  );
  const xml = await readFile(report, "utf8");
  assert(!/<(?:failure|error)\b/.test(xml), "JUnit contains a failed check");
  const executed = [
    ...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
  ]
    .filter((match) => !/<skipped\b/.test(match[2] || ""))
    .map((match) => {
      const name = match[1].match(/\bname="([^"]+)"/)?.[1];
      assert(name, "JUnit testcase is missing its name");
      return name
        .replaceAll("&apos;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
    })
    .sort();
  assert.deepEqual(
    executed,
    [...names].sort(),
    "Required Job execution lease checks did not all execute",
  );
  results.push({ file, names: executed, report });
}

await run(
  "packages/cloud/shared/src/db/repositories/job-execution-lease.postgres.integration.test.ts",
  [
    "claim skips a locked due row and installs the exact owner lease",
    "a failed lease installation rolls back the job claim",
    "an expired lease can renew before recovery commits",
    "recovery replaces a generation and refuses stale mutation and settlement",
    "same-generation terminal rejection is replay-safe and classified settled",
    "a failed claim response leaves a recoverable generation and lease",
    "renewal during recovery hydration invalidates the selected stale snapshot",
    "dependent failure rolls back recovery and remains retryable",
    "restart recovery consumes the interruption budget without spending attempts",
    "a legacy in-progress row acquires a fresh generation after recovery",
    "lifecycle settlement requires and releases the exact resource fence",
    "a missing lifecycle resource permits terminal job cleanup",
    "recovery preserves a lifecycle fence held by another job",
    "ordinary failure retries use exponential backoff and roll back failed writebacks",
    "concurrent ordinary failures spend one attempt and stale generations spend none",
    "durable timeout preserves attempts while restart spends interruptions",
    "requeue refuses a stale payload and unbounded retry preserves all counters",
    "committed canary recovery preserves both attempt and interruption budgets",
    "changed canary evidence invalidates a selected preservation snapshot",
    "concurrent exhausted recovery commits one counter and dependent receipt",
    "bounded requeue allowance 0 is spent separately from attempts",
    "bounded requeue allowance 5 is spent separately from attempts",
    "bounded requeue allowance 10 is spent separately from attempts",
  ],
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Job execution lease conformance passed 23 required tests. Results ${directory}`,
);
