/** Checks task-store receipts through the real SQLite-backed Durable Object. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/a2a_task_store.qnt"),
  "A2A conformance requires its own model path",
);
const output = testOutputPath("quint-a2a-task-store");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
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
    // Match the owning package's run-unit-isolated.mjs deadline.
    "--timeout=60000",
    "packages/cloud/api/__tests__/a2a-task-state-workerd.test.ts",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(result.signal, null, "A2A conformance was interrupted");
assert.equal(
  result.status,
  0,
  `A2A implementation checks failed. See ${directory}`,
);
const xml = await readFile(report, "utf8");
assert(
  !/<(?:failure|error|skipped)\b/.test(xml),
  "JUnit contains a failed or skipped check",
);
const names = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
  .map((match) =>
    match[1]
      .replaceAll("&apos;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&"),
  )
  .sort();
assert.deepEqual(
  names,
  [
    "concurrent history, artifacts and cancellation survive restart without losing complete content",
    "tenant reads, listing and deletion cannot affect another organization",
    "versioned competing updates retry without losing content order or duplicates",
    "deletion and recreation refuse the original version receipt",
    "expired task versions cannot restore deleted content or listing entries",
    "rejected foreign requests retain the owner's open import phase",
    "conflicting import batches do not retain preceding new rows or receipts",
    "import retains ordering and expiry, rejects conflicts and permanently closes after use",
    "stored task expiry survives restart and removes the listing entry",
    "selected store refuses missing bindings instead of falling back to mock Redis",
  ].sort(),
  "All ten required A2A implementation checks must execute",
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", tests: names, report }, null, 2)}\n`,
);
console.log(
  `A2A task-store conformance passed ten required tests. Results ${directory}`,
);
