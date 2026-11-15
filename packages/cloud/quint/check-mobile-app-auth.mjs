/** Check mobile grant exchange, acknowledgement and cleanup against real PostgreSQL. */
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
  "Mobile App Auth conformance requires an isolated loopback qa_* PostgreSQL role",
);
const output = testOutputPath("quint-mobile-app-auth");
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
    `Mobile App Auth implementation checks failed for ${file}`,
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
    "Required Mobile App Auth checks did not all execute",
  );
  results.push({ file, names: executed, report });
}

await run(
  "packages/cloud/shared/src/lib/services/auth-credential-policy.postgres.integration.test.ts",
  [
    "mobile exchange, acknowledgement and replay commit one credential with enrolled policy",
    "mobile exchange returns the same encrypted credential on a valid retry",
    "mobile exchange rejects mismatched client, state and PKCE bindings",
    "mobile issuance, exchange and acknowledgement preserve one active-client grant",
    "mobile exchange refuses client deactivation during actual decryption",
    "mobile exchange refuses expired authority after actual decryption",
    "mobile exchange refuses a replay when acknowledgement commits during decryption",
    "a landed acknowledgement replays after the code's acknowledgeBy; one that never landed is refused",
    "expiry cleanup fences every organization before tombstoning inactive and acknowledged credentials",
    "mobile cleanup preserves shared credential references",
    "mobile cleanup drains valid rows beside malformed pending grants",
    "bounded cleanup passes locked candidates and reaches later expired grants",
    "acknowledgement and an unmanaged Steward link on one user take locks in one order",
    "permit failure rolls back the mobile claim without minting a credential",
    "acknowledgement cannot activate a credential after the planned grant owner changes",
    "cleanup retries instead of writing a grant whose planned owner changed",
  ],
  "mobile|acknowledgement|expiry cleanup|bounded cleanup|permit failure|cleanup retries",
);

await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Mobile App Auth conformance passed 16 required tests. Results ${directory}`,
);
