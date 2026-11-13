/** Executes the complete encrypted-filesystem and process-death contract suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const testFile = "packages/auth/src/auth/account-storage-subprocess.test.ts";
const requiredTests = [
  "account storage subprocess ownership refuses a missing runtime vault key even under test process signals",
  "account storage subprocess ownership keeps runtime credentials readable after bun test signals and process restart",
  "account storage subprocess ownership keeps runtime credentials readable after node-test test signals and process restart",
  "account storage subprocess ownership uses explicit isolated authority under bun",
  "account storage subprocess ownership uses explicit isolated authority under node-test",
  "account storage subprocess ownership does not let an inherited global bypass authorize a symlink root",
  "account storage subprocess ownership fences a stale bun writer that races a full reset",
  "account storage subprocess ownership fences a stale node-test writer that races a full reset",
  "resolves the production master key once per list and observes changed authority on the next list",
  "retires a partially published lock when owner fsync fails",
  "fences a pending writer after reset-first-file process death and recovers on restart",
  "fences a pending writer after reset-callback process death and recovers on restart",
  "fences a pending writer after reset-generation process death and recovers on restart",
  "retains a live successor when a stale lock observation is renamed",
  "restores complete encrypted artifacts when the one-shot reset callback fails",
  "keeps a published reset generation fenced when its directory fsync fails",
  "rejects malformed reset intent before changing encrypted artifacts",
  "retries reset recovery after the recovering process dies during deletion",
  "admits a waiting process after owner fsync failure while the failed owner remains alive",
  "keeps an unconfirmed reset fenced after intent unlink failure",
  "keeps an unconfirmed reset fenced after intent fsync failure",
  "checks the acquisition deadline after a raced-away lock directory",
  "rejects generation exhaustion before deleting any credential or invoking the host",
];
const skippedTests =
  process.platform === "win32"
    ? [
        "keeps a published reset generation fenced when its directory fsync fails",
        "keeps an unconfirmed reset fenced after intent fsync failure",
      ]
    : [];
const sources = [
  "packages/auth/src/auth/account-storage.ts",
  testFile,
  "packages/auth/test/fixtures/storage-ownership-probe.ts",
  "packages/auth/test/fixtures/account-storage-subprocess-probe.ts",
  "packages/auth/quint/AccountStorageLock.qnt",
  "packages/auth/quint/AccountStorageReset.qnt",
  "packages/scripts/lib/vitest-conformance.ts",
];
const output = testOutputPath("quint-account-storage");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const resultPath = path.join(directory, "tests.json");
const run = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    "src/auth/account-storage-subprocess.test.ts",
    "--reporter=json",
    `--outputFile=${resultPath}`,
  ],
  {
    cwd: path.join(root, "packages/auth"),
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
);
if (run.error) throw run.error;
assert.equal(run.signal, null, `Conformance terminated by ${run.signal}`);
assert.equal(run.status, 0, `Conformance failed. See ${directory}/tests.log`);
const tests = requireVitestConformance(
  JSON.parse(await readFile(resultPath, "utf8")),
  path.join(root, testFile),
  requiredTests,
  skippedTests,
);
const hashes = {};
for (const source of sources) {
  hashes[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
const evidence = {
  sources: hashes,
  tests,
  report: resultPath,
  limitations: [
    "Runtime vault selection and persistence are exercised by real Bun/Node subprocesses; the finite ownership graph does not prove cryptography or the key loader.",
    "Controlled process schedules, not every TLC interleaving.",
    "Power-loss and arbitrary kernel I/O failures are not simulated exhaustively.",
    "Interrupted reset remains an unknown outcome; host callback recovery is caller-owned.",
    "Windows intentionally omits directory fsync and skips only the two named directory-fsync fault cases.",
  ],
};
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
await writeFile(
  path.join(output, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  `Account storage conformance passed ${tests.length - skippedTests.length} required cases. Evidence ${directory}`,
);
