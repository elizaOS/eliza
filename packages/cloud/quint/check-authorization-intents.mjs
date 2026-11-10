/** Check source-linked authorization intent transitions against real SQL transactions. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-authorization-intents");
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
    `Authorization intent implementation checks failed for ${file}`,
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
    "Required Authorization intent checks did not all execute",
  );
  results.push({ file, names: executed, report });
}

await run(
  "packages/cloud/shared/src/db/repositories/authorization-intents.pglite.test.ts",
  [
    "production decisions compare expiry with database time",
    "competing OAuth decisions cannot replace the winning outcome or duplicate its receipt",
    "approval delivery cannot overwrite a completed decision",
    "decisions at or beyond expiry fail before a sweeper runs",
    "cancellation compares the tenant on the committing write",
    "receipt failure rolls back the OAuth decision",
    "receipt failure rolls back the signed approval",
    "creation does not leave an unreceipted intent",
    "expiry uses an inclusive boundary and writes receipts in the same transaction",
  ],
);

await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Authorization intent conformance passed 9 required tests. Results ${directory}`,
);
