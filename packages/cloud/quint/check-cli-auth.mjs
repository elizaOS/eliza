/** Compare the CLI auth model with actual primary SQL and service boundaries. */
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
  "CLI auth conformance requires an isolated loopback qa_* PostgreSQL role",
);
const output = testOutputPath("quint-cli-auth");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];

async function run(file, names, pattern) {
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
      ...(pattern ? ["--test-name-pattern", pattern] : []),
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
    `CLI auth implementation checks failed for ${file}`,
  );
  const xml = await readFile(report, "utf8");
  assert(!/<(?:failure|error)\b/.test(xml), "JUnit contains a failed check");
  const executed = [
    ...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
  ]
    .filter((match) => !/<skipped\b/.test(match[2] || ""))
    .map((match) => match[1].match(/\bname="([^"]+)"/)?.[1])
    .sort();
  assert.deepEqual(
    executed,
    [...names].sort(),
    "Required CLI auth checks did not all execute",
  );
  results.push({ file, names: executed, report });
}

await run(
  "packages/cloud/shared/src/lib/services/cli-session-poll.integration.test.ts",
  [
    "new sessions remain pollable before replica arrival; completion and expiry use current primary state",
    "the reply that reveals the key says whether this sign-in made the account",
    "CLI reveal leaves the claim retryable after a KMS failure",
    "CLI reveal refuses malformed legacy credential bindings before decryption",
    "CLI reveal rechecks revocation, owner and key hash after external decryption",
    "a session created with a verifier hash releases its key only to that verifier",
  ],
);
await run(
  "packages/cloud/shared/src/lib/services/auth-credential-policy.postgres.integration.test.ts",
  [
    "CLI consumed credentials survive cleanup after concurrent one-shot delivery",
    "CLI cleanup cannot strand an active key from a completion admitted before expiry",
    "CLI completion encrypts, commits and replays its single credential through enrolled policy",
  ],
  "CLI",
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `CLI auth conformance passed 9 required tests. Results ${directory}`,
);
