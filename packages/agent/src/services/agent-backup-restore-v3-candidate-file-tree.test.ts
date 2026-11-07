/**
 * Real filesystem inventories at the file-tree's documented limits. Capture v2
 * admits up to maxFiles files per component, and generation inventories every
 * component together, so restore must digest any tree inside these limits.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS,
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";

/** Load-tolerant wall-clock test budget; no deadline here proves expiry. */
const TEST_BUDGET_MS = 10 * 60_000;
vi.setConfig({ testTimeout: TEST_BUDGET_MS, hookTimeout: TEST_BUDGET_MS });

const { maximumFiles, maximumDirectories } =
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS;
const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const control = () => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + TEST_BUDGET_MS,
});

afterEach(async () => {
  for (const candidate of candidates) await candidate.close();
  candidates.clear();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

async function writeFiles(files: readonly string[]): Promise<void> {
  for (let start = 0; start < files.length; start += 512)
    await Promise.all(
      files
        .slice(start, start + 512)
        .map((file) => fs.writeFile(file, "x", { mode: 0o600 })),
    );
}

/** Lays out `files` one-byte files under components/, optionally one per directory. */
async function candidateWithFiles(files: number, ownDirectories = false) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-v3-file-tree-"),
  );
  roots.add(root);
  await fs.chmod(root, 0o700);
  const attemptRoot = path.join(root, "attempt");
  const plugin = path.join(attemptRoot, "components", "plugin");
  await fs.mkdir(plugin, { recursive: true, mode: 0o700 });
  const names = Array.from(
    { length: files },
    (_, index) => `f${String(index).padStart(5, "0")}`,
  );
  if (ownDirectories) {
    // components/plugin/ is the first of the directories.
    for (let start = 1; start < files; start += 512)
      await Promise.all(
        names
          .slice(start, start + 512)
          .map((name) => fs.mkdir(path.join(plugin, name), { mode: 0o700 })),
      );
  }
  await writeFiles(
    names.map((name, index) =>
      ownDirectories && index >= 1
        ? path.join(plugin, name, "index.js")
        : path.join(plugin, `${name}.js`),
    ),
  );
  const candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: root,
    attemptRoot,
    control: control(),
    ...(process.platform === "linux"
      ? {}
      : { testOnlyAllowNonLinuxFdEmulation: true as const }),
  });
  candidates.add(candidateFs);
  return candidateFs;
}

describe("candidate file-tree inventory at its documented limits", () => {
  it("inventories and re-proves maximumFiles files across maximumDirectories directories", async () => {
    expect(maximumDirectories).toBe(maximumFiles);
    const candidateFs = await candidateWithFiles(maximumFiles, true);
    const lock = await candidateFs.acquireLock("tree.lock", control());
    try {
      const inventory = await candidateFs.inspectFileTree(
        "components",
        control(),
        lock,
      );
      expect(inventory).toMatchObject({
        files: maximumFiles,
        directories: maximumDirectories,
      });
      expect(inventory.directoryPaths).toHaveLength(maximumDirectories);
      const proved = await candidateFs.proveFileTree(
        "components",
        inventory.entries,
        undefined,
        control(),
        lock,
      );
      expect(proved.sha256).toBe(inventory.sha256);
    } finally {
      await lock.release(control());
    }
  });

  it("still refuses one file beyond maximumFiles", async () => {
    const candidateFs = await candidateWithFiles(maximumFiles + 1);
    const lock = await candidateFs.acquireLock("tree.lock", control());
    try {
      await expect(
        candidateFs.inspectFileTree("components", control(), lock),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
      });
    } finally {
      await lock.release(control());
    }
  });
});
