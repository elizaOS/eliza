import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

test("source lock updater changes only immutable identity fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eliza-lock-"));
  const lock = path.join(directory, "lock.json");
  await writeFile(
    lock,
    await readFile(
      path.join(repoRoot, "release/eliza-source.lock.json"),
    ),
  );
  await execFileAsync(
    process.execPath,
    [
      "scripts/update-eliza-source-lock.mjs",
      "--lock",
      lock,
      "--commit",
      "a".repeat(40),
      "--commit-timestamp",
      "2026-08-17T12:00:00Z",
    ],
    { cwd: repoRoot },
  );
  const updated = JSON.parse(await readFile(lock, "utf8"));
  assert.equal(updated.commit, "a".repeat(40));
  assert.equal(updated.commitTimestamp, "2026-08-17T12:00:00Z");
  assert.equal(updated.repository, "elizaOS/eliza");
  assert.equal(updated.sourceRef, "develop");
  assert.equal(updated.submodules, "recursive");
});
