/** Executes real encrypted-filesystem and process-death contract scenarios. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sources = [
  "packages/auth/src/auth/account-storage.ts",
  "packages/auth/src/auth/account-storage-subprocess.test.ts",
  "packages/auth/test/fixtures/storage-ownership-probe.ts",
  "packages/auth/quint/AccountStorageLock.qnt",
  "packages/auth/quint/AccountStorageReset.qnt",
];
const output = testOutputPath("quint-account-storage");
await mkdir(output, { recursive: true });
const run = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    "src/auth/account-storage-subprocess.test.ts",
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
  path.join(output, "conformance.log"),
  `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
);
if (run.error) throw run.error;
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
const hashes = {};
for (const source of sources) {
  hashes[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(output, "evidence.json"),
  JSON.stringify(
    {
      sources: hashes,
      scenarios: [
        "real Bun/Node completed-reset fencing",
        "partial owner publication EIO cleanup and encrypted retry",
        "SIGKILL after first credential unlink, host callback and generation rename",
        "fresh runtime policy restart rejects old writer and cannot consume revived account",
        "stale reaper rename preserves a live successor until release",
        "interrupted recovery retries without host callback replay",
        "intent unlink/fsync uncertainty retains the generation fence",
        "owner fsync failure admits a waiter while the failed owner remains alive",
      ],
      limitations: [
        "Scenario conformance covers controlled process schedules, not every TLC interleaving.",
        "Filesystem syscall ordering is real; power-loss and arbitrary kernel I/O failures are not simulated exhaustively.",
        "Full host configuration callback recovery remains caller-owned and an interrupted reset has an unknown result.",
      ],
    },
    null,
    2,
  ),
);
console.log("Account storage encrypted-filesystem conformance passed");
