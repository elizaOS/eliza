/**
 * Real filesystem commit/replay faults with synthetic preparation receipts.
 * These tests own the promotion boundary, not authenticated capture or database
 * validity; the assembly integration covers an actual five-component PGlite restore.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import type { AgentBackupRestoreV3PreparedGenerationReceipt } from "./agent-backup-restore-v3-generation";
import { commitAgentBackupRestoreV3Generation } from "./agent-backup-restore-v3-generation-commit";

const roots = new Set<string>();
const handles = new Set<AgentBackupRestoreV3CandidateFs>();
const control = () => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + 30_000,
});
const hash = (value: unknown) =>
  createHash("sha256").update(candidateFsCanonicalJson(value)).digest("hex");
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-v3-commit-"),
  );
  roots.add(root);
  const trustedRoot = path.join(root, "private");
  const attemptRoot = path.join(trustedRoot, "attempt");
  const runtimeRoot = path.join(root, "runtime");
  await fs.mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(runtimeRoot, { mode: 0o700 });
  const generationFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot,
    attemptRoot,
    control: control(),
    ...(process.platform === "linux"
      ? {}
      : { testOnlyAllowNonLinuxFdEmulation: true as const }),
  });
  handles.add(generationFs);
  const lock = await generationFs.acquireLock(
    ".restore-v3-generation.lock",
    control(),
  );
  let preparedReceipt: AgentBackupRestoreV3PreparedGenerationReceipt;
  try {
    const writer = await generationFs.createFileTreeFile(
      "generation",
      { path: "state/fact", sizeBytes: 4, mode: 0o600, mtimeMs: 0 },
      undefined,
      control(),
      lock,
    );
    await writer.write(new TextEncoder().encode("fact"), control());
    await writer.finalize(control());
    const tree = await generationFs.inspectFileTree(
      "generation",
      control(),
      lock,
    );
    const body = {
      version: 1 as const,
      format: "elizaos.agent-backup.restore-v3-generation-prepared.v1" as const,
      assemblySha256: "a".repeat(64),
      sourceTreeSha256: "b".repeat(64),
      targetRoot: generationFs.attemptRootIdentity,
      paths: {
        character: "generation/character/character.json" as const,
        database: "generation/database" as const,
        state: "generation/state" as const,
      },
      treeSha256: tree.sha256,
      files: tree.files,
      directories: tree.directories,
      bytes: tree.bytes,
    };
    preparedReceipt = { ...body, receiptSha256: hash(body) };
    await generationFs.publishDurableJson(
      ".restore-v3-generation-prepared.json",
      preparedReceipt,
      { maximumBytes: 16384 },
      control(),
      lock,
    );
  } finally {
    await lock.release(control());
  }
  const stat = await fs.stat(runtimeRoot, { bigint: true });
  return {
    root,
    request: {
      generationFs,
      preparedReceipt,
      runtimeRoot,
      runtimeRootIdentity: {
        device: String(stat.dev),
        inode: String(stat.ino),
      },
    },
    attemptRoot,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles) await handle.close();
  handles.clear();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

it("retains a pre-rename intent across cancellation and rejects a conflicting destination", async () => {
  const { root, request, attemptRoot } = await fixture();
  const cancelled = new AbortController();
  const link = fs.link.bind(fs);
  const fault = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
    await link(from, to);
    if (String(to).endsWith("/.restore-v3-generation-commit-intent.json"))
      cancelled.abort();
  });
  try {
    await expect(
      commitAgentBackupRestoreV3Generation({
        ...request,
        control: { ...control(), signal: cancelled.signal },
      }),
    ).rejects.toThrow();
  } finally {
    fault.mockRestore();
  }
  expect(await fs.readdir(request.runtimeRoot)).toEqual([]);
  expect(
    await fs.readFile(path.join(attemptRoot, "generation/state/fact"), "utf8"),
  ).toBe("fact");
  const alternate = path.join(root, "alternate");
  await fs.mkdir(alternate, { mode: 0o700 });
  const stat = await fs.stat(alternate, { bigint: true });
  await expect(
    commitAgentBackupRestoreV3Generation({
      ...request,
      runtimeRoot: alternate,
      runtimeRootIdentity: {
        device: String(stat.dev),
        inode: String(stat.ino),
      },
      control: control(),
    }),
  ).rejects.toMatchObject({
    code: "AGENT_BACKUP_RESTORE_V3_GENERATION_COMMIT_INTENT_CONFLICT",
  });
  expect(await fs.readdir(alternate)).toEqual([]);
  const committed = await commitAgentBackupRestoreV3Generation({
    ...request,
    control: control(),
  });
  expect(
    await fs.readFile(path.join(committed.paths.state, "fact"), "utf8"),
  ).toBe("fact");
});

it("rejects pre-aborted and forged prepared authority without publishing intent", async () => {
  const { request, attemptRoot } = await fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    commitAgentBackupRestoreV3Generation({
      ...request,
      control: { ...control(), signal: cancelled.signal },
    }),
  ).rejects.toMatchObject({
    code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
  });
  await expect(
    commitAgentBackupRestoreV3Generation({
      ...request,
      preparedReceipt: {
        ...request.preparedReceipt,
        receiptSha256: "0".repeat(64),
      },
      control: control(),
    }),
  ).rejects.toMatchObject({
    code: "AGENT_BACKUP_RESTORE_V3_GENERATION_COMMIT_PREPARED_CONFLICT",
  });
  await expect(
    fs.access(
      path.join(attemptRoot, ".restore-v3-generation-commit-intent.json"),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(request.runtimeRoot)).toEqual([]);
});

it("refuses a replaced or symlinked runtime parent without touching the committed generation", async () => {
  const { root, request } = await fixture();
  const committed = await commitAgentBackupRestoreV3Generation({
    ...request,
    control: control(),
  });
  const moved = path.join(root, "original-runtime");
  await fs.rename(request.runtimeRoot, moved);
  await fs.symlink(moved, request.runtimeRoot);
  await expect(
    commitAgentBackupRestoreV3Generation({ ...request, control: control() }),
  ).rejects.toThrow();
  await fs.unlink(request.runtimeRoot);
  await fs.mkdir(request.runtimeRoot, { mode: 0o700 });
  await expect(
    commitAgentBackupRestoreV3Generation({ ...request, control: control() }),
  ).rejects.toThrow();
  expect(await fs.readdir(request.runtimeRoot)).toEqual([]);
  expect(
    await fs.readFile(
      path.join(
        moved,
        path.relative(request.runtimeRoot, committed.paths.state),
        "fact",
      ),
      "utf8",
    ),
  ).toBe("fact");
});
