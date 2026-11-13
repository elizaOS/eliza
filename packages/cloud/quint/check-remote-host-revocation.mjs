/** Check remote-host revocation and cleanup against real database transitions. */
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
  "Remote host revocation conformance requires an isolated loopback qa_* PostgreSQL role",
);
const output = testOutputPath("quint-remote-host-revocation");
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
    `Remote host revocation implementation checks failed for ${file}`,
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
    "Required Remote host revocation checks did not all execute",
  );
  results.push({ file, names: executed, report });
}

await run(
  "packages/cloud/shared/src/db/repositories/remote-command-envelopes.pglite.test.ts",
  [
    "rolls host revocation back when session terminalization fails",
    "revokes claimed target pairings before reporting host cleanup complete",
    "keeps managed enrollment non-authoritative until durable activation",
    "revokes a pending managed host without ever granting bearer authority",
    "records a host heartbeat even when its active session has no command",
    "recovers a lost host token only for the exact active public identity",
    "runs target challenge claim, confirmation, expiry, denial, replay, and no-resurrection",
    "consumes a host-bound pairing verifier only once",
    "discovers one host-bound session from only its six-digit code",
    "commits an exact staged activation idempotently without admitting pre-commit commands",
    "serializes staged commit against host finalization",
    "compensates an exact activation idempotently under host finalization",
    "serializes activation compensation with host finalization",
    "serializes sequence, nonce, and idempotency under the session lock",
    "rejects an envelope that is not bound to the authenticated owner",
    "retries only an expired pre-start claim and fences its stale attempt",
    "persists start evidence and never requeues post-start uncertainty",
    "expires bounded pre-start work and marks started work ambiguous with its grant",
    "binds completion to the exact claim attempt and durable start receipt",
    "turns started work ambiguous and pre-start work cancelled on revocation",
    "lets the exact host bearer revoke and continue its own bounded cleanup",
    "serializes revoke against enqueue and leaves no executable command",
  ],
);
await run(
  "packages/cloud/shared/src/db/repositories/remote-host-revocation.postgres.integration.test.ts",
  ["reports a locked claimed pairing and drains it on the next revocation"],
);

await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Remote host revocation conformance passed 23 required tests. Results ${directory}`,
);
