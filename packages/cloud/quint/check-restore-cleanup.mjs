/** Check exact cleanup against the real SQL repository and coordinator. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const modelPaths = [
  "exact_restore_recovery.qnt",
  "restore_cleanup_rotation.qnt",
].map((file) => path.join(root, "packages/cloud/quint", file));
if (
  process.argv.length > 3 ||
  (process.argv[2] && !modelPaths.includes(path.resolve(root, process.argv[2])))
)
  throw new Error("Restore cleanup conformance requires its own model");
const output = testOutputPath("quint-restore-cleanup");
await mkdir(output, { recursive: true });
const runDirectory = await mkdtemp(path.join(output, "run-"));
const report = path.join(runDirectory, "tests.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    "bun",
    "test",
    "--conditions=eliza-source",
    "packages/cloud/shared/src/lib/services/__tests__/agent-backup-restore-coordinator.pglite.test.ts",
    "--max-concurrency=1",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Restore cleanup implementation checks failed");
const xml = await readFile(report, "utf8");
assert(
  !/<(?:failure|error|skipped)\b/.test(xml),
  "JUnit contains a failure or skipped check",
);
const names = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
  .map((match) =>
    match[1]
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  )
  .sort();
assert.deepEqual(
  names,
  [
    "walks a settled quarantine container to a finalized, routed restore",
    "rolls back to the previous runtime when a probe signature is forged",
    "retries a lost pre-boot controller response and resumes the recorded phase",
    "selects the agent's current node first and otherwise the least-loaded eligible node",
    "terminal unresolved create stays quarantined until the delayed daemon candidate is removed",
    "terminal unresolved create with proven producer quiescence releases its reserved slot",
    "terminal cleanup retains exact node authority instead of using its replacement",
    "terminal cleanup selects the active attempt after earlier proven cleanup and releases once across concurrent turns",
    "a node replacement after remote proof cannot consume the replacement node's capacity",
    "terminal cleanup rotates permanent quarantines so later recoverable attempts are not starved",
  ].sort(),
  "Required cleanup checks were not all executed",
);
await writeFile(
  path.join(output, "results.json"),
  `${JSON.stringify(
    {
      result: "passed",
      tests: names,
      report,
    },
    null,
    2,
  )}\n`,
);
