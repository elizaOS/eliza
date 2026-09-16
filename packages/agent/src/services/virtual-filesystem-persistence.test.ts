/**
 * Exercises saved VFS state using real temporary directories, filesystem faults,
 * interrupted directory swaps, and concurrent service/Git/shell operations.
 * No filesystem operation is mocked; each failure is checked against live bytes.
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runVfsBuiltinShell } from "./vfs-builtin-shell.ts";
import { createVfsGitService } from "./vfs-git.ts";
import { VirtualFilesystemService } from "./virtual-filesystem.ts";

let stateDir: string;
const projectId = "persisted-workspace";
const service = () => new VirtualFilesystemService({ stateDir, projectId });

beforeEach(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-persistence-"));
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fsp.rm(stateDir, { recursive: true, force: true });
});

async function savedWorkspace() {
  const vfs = service();
  await vfs.writeFile("state.txt", "saved bytes");
  const snapshot = await vfs.createSnapshot();
  await vfs.writeFile("state.txt", "current bytes");
  return {
    vfs,
    snapshot,
    metadata: path.join(vfs.snapshotsRoot, snapshot.id, "snapshot.json"),
  };
}

async function names(root: string) {
  return (await fsp.readdir(root)).sort();
}

describe("snapshot restore quotas", () => {
  it("rejects a file exceeding the current limit before changing live or saved state", async () => {
    const initial = new VirtualFilesystemService({
      stateDir,
      projectId,
      maxFileBytes: 16,
    });
    await initial.writeFile("nested/state.txt", "0123456789");
    const oversized = await initial.createSnapshot();
    await initial.writeFile("nested/state.txt", "ok");
    const valid = await initial.createSnapshot();
    await initial.writeFile("nested/state.txt", "now");
    const limited = new VirtualFilesystemService({
      stateDir,
      projectId,
      maxFileBytes: 4,
    });
    const before = await names(limited.projectRoot);
    const snapshots = await limited.listSnapshots();

    await expect(limited.rollback(oversized.id)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(await service().readFile("nested/state.txt")).toBe("now");
    expect(await names(limited.projectRoot)).toEqual(before);
    expect(await limited.listSnapshots()).toEqual(snapshots);

    await limited.rollback(valid.id);
    expect(await service().readFile("nested/state.txt")).toBe("ok");
  });
});

describe("saved VFS metadata", () => {
  it("distinguishes absence from an actual metadata read failure", async () => {
    const { vfs, snapshot, metadata } = await savedWorkspace();
    await expect(vfs.getSnapshot("missing")).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
    });
    await fsp.rm(metadata);
    await fsp.mkdir(metadata);
    await expect(vfs.getSnapshot(snapshot.id)).rejects.toMatchObject({
      code: "VFS_STORAGE_FAILED",
      cause: { code: "EISDIR" },
    });
    await expect(vfs.listSnapshots()).rejects.toMatchObject({
      code: "VFS_STORAGE_FAILED",
    });
    expect(await vfs.readFile("state.txt")).toBe("current bytes");
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong project", { projectId: "another-project" }],
    ["wrong id", { id: "another-snapshot" }],
    ["invalid timestamp", { createdAt: "not-a-date" }],
    ["negative byte count", { filesBytes: -1 }],
    ["fractional count", { fileCount: 0.5 }],
    ["string byte count", { filesBytes: "11" }],
    ["invalid note", { note: false }],
  ])(
    "rejects %s before mutating any saved or live state",
    async (_name, invalid) => {
      const { vfs, snapshot, metadata } = await savedWorkspace();
      await fsp.writeFile(
        metadata,
        typeof invalid === "string"
          ? invalid
          : JSON.stringify({ ...snapshot, ...invalid }),
      );
      const projectBefore = await names(vfs.projectRoot);
      const snapshotsBefore = await names(vfs.snapshotsRoot);
      await expect(vfs.listSnapshots()).rejects.toMatchObject({
        code: "INVALID_SNAPSHOT",
      });
      await expect(vfs.rollback(snapshot.id)).rejects.toMatchObject({
        code: "INVALID_SNAPSHOT",
      });
      expect(await vfs.readFile("state.txt")).toBe("current bytes");
      expect(await names(vfs.projectRoot)).toEqual(projectBefore);
      expect(await names(vfs.snapshotsRoot)).toEqual(snapshotsBefore);
    },
  );

  it("treats an incomplete saved directory as corruption instead of hiding it", async () => {
    const { vfs, metadata } = await savedWorkspace();
    await fsp.rm(metadata);
    await expect(vfs.listSnapshots()).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT",
    });
  });

  it.each(["missing", "changed", "symlink"])(
    "rejects a %s saved tree without a backup or live mutation",
    async (fault) => {
      const { vfs, snapshot } = await savedWorkspace();
      const target = path.join(snapshot.root, "state.txt");
      if (fault === "missing") await fsp.rm(snapshot.root, { recursive: true });
      if (fault === "changed") await fsp.writeFile(target, "different length");
      if (fault === "symlink") {
        await fsp.rm(target);
        await fsp.symlink(path.join(vfs.filesRoot, "state.txt"), target);
      }
      const before = await names(vfs.projectRoot);
      await expect(vfs.rollback(snapshot.id)).rejects.toMatchObject({
        code: fault === "symlink" ? "SYMLINK_DENIED" : "INVALID_SNAPSHOT",
      });
      expect(await vfs.readFile("state.txt")).toBe("current bytes");
      expect(await names(vfs.projectRoot)).toEqual(before);
      expect(await names(vfs.snapshotsRoot)).toEqual([snapshot.id]);
    },
  );

  it("does not publish a snapshot when a real tree validation fails", async () => {
    const vfs = service();
    await vfs.writeFile("state.txt", "current bytes");
    await fsp.symlink(
      path.join(vfs.filesRoot, "state.txt"),
      path.join(vfs.filesRoot, "link"),
    );
    await expect(vfs.createSnapshot()).rejects.toMatchObject({
      code: "SYMLINK_DENIED",
    });
    expect(await vfs.listSnapshots()).toEqual([]);
    expect(await names(vfs.projectRoot)).toEqual(["files", "snapshots"]);
    expect(
      await fsp.readFile(path.join(vfs.filesRoot, "state.txt"), "utf8"),
    ).toBe("current bytes");
  });
});

describe("recoverable VFS rollback", () => {
  it("restores the original directory when the commit record cannot be written", async () => {
    const { vfs, snapshot } = await savedWorkspace();
    const marker = path.join(vfs.projectRoot, "last-rollback.json");
    await fsp.mkdir(marker);
    await fsp.writeFile(
      path.join(marker, "fault.txt"),
      "prevent replacing this directory",
    );
    await expect(vfs.rollback(snapshot.id)).rejects.toMatchObject({
      code: "ROLLBACK_FAILED",
    });
    expect(await service().readFile("state.txt")).toBe("current bytes");
    expect(await names(vfs.projectRoot)).toEqual([
      "files",
      "last-rollback.json",
      "snapshots",
    ]);
    const recoverySnapshot = (await vfs.listSnapshots()).find(
      (item) => item.id !== snapshot.id,
    );
    if (!recoverySnapshot)
      throw new Error("Missing pre-rollback recovery snapshot");
    expect(
      await fsp.readFile(path.join(recoverySnapshot.root, "state.txt"), "utf8"),
    ).toBe("current bytes");
    await fsp.rm(marker, { recursive: true });
    await vfs.rollback(snapshot.id);
    expect(await vfs.readFile("state.txt")).toBe("saved bytes");
  });

  it.each(["prepared", "backed-up", "installed", "committed"])(
    "recovers an interruption after %s",
    async (phase) => {
      const { vfs, snapshot } = await savedWorkspace();
      const previous = await vfs.createSnapshot();
      const stageName = `.rollback-stage-${crypto.randomUUID()}`;
      const backupName = `.rollback-backup-${crypto.randomUUID()}`;
      const stage = path.join(vfs.projectRoot, stageName);
      const backup = path.join(vfs.projectRoot, backupName);
      const rollback = {
        projectId,
        snapshotId: snapshot.id,
        previousSnapshotId: previous.id,
        rolledBackAt: new Date().toISOString(),
      };
      await fsp.cp(snapshot.root, stage, { recursive: true });
      await fsp.writeFile(
        path.join(vfs.projectRoot, ".pending-rollback.json"),
        JSON.stringify({ version: 1, stageName, backupName, rollback }),
      );
      if (phase !== "prepared") await fsp.rename(vfs.filesRoot, backup);
      if (phase === "installed" || phase === "committed")
        await fsp.rename(stage, vfs.filesRoot);
      if (phase === "committed")
        await fsp.writeFile(
          path.join(vfs.projectRoot, "last-rollback.json"),
          JSON.stringify(rollback),
        );
      const restarted = service();
      await restarted.initialize();
      expect(await restarted.readFile("state.txt")).toBe(
        phase === "committed" ? "saved bytes" : "current bytes",
      );
      expect(await names(vfs.projectRoot)).toEqual(
        phase === "committed"
          ? ["files", "last-rollback.json", "snapshots"]
          : ["files", "snapshots"],
      );
      await restarted.writeFile("after-recovery.txt", "writable");
      expect(await service().readFile("after-recovery.txt")).toBe("writable");
    },
  );

  it("does not guess a recovery outcome when the commit marker is invalid", async () => {
    const { vfs, snapshot } = await savedWorkspace();
    const previous = await vfs.createSnapshot();
    const stageName = `.rollback-stage-${crypto.randomUUID()}`;
    const backupName = `.rollback-backup-${crypto.randomUUID()}`;
    const rollback = {
      projectId,
      snapshotId: snapshot.id,
      previousSnapshotId: previous.id,
      rolledBackAt: new Date().toISOString(),
    };
    const pending = path.join(vfs.projectRoot, ".pending-rollback.json");
    await fsp.cp(snapshot.root, path.join(vfs.projectRoot, stageName), {
      recursive: true,
    });
    await fsp.writeFile(
      pending,
      JSON.stringify({ version: 1, stageName, backupName, rollback }),
    );
    await fsp.writeFile(path.join(vfs.projectRoot, "last-rollback.json"), "{}");
    const before = await names(vfs.projectRoot);
    await expect(service().initialize()).rejects.toMatchObject({
      code: "ROLLBACK_RECOVERY_FAILED",
    });
    expect(
      await fsp.readFile(path.join(vfs.filesRoot, "state.txt"), "utf8"),
    ).toBe("current bytes");
    expect(await names(vfs.projectRoot)).toEqual(before);
  });

  it("preserves evidence and live bytes when recovery metadata is invalid", async () => {
    const { vfs } = await savedWorkspace();
    const pending = path.join(vfs.projectRoot, ".pending-rollback.json");
    await fsp.writeFile(pending, JSON.stringify({ version: 0 }));
    await expect(service().initialize()).rejects.toMatchObject({
      code: "ROLLBACK_RECOVERY_FAILED",
    });
    expect(
      await fsp.readFile(path.join(vfs.filesRoot, "state.txt"), "utf8"),
    ).toBe("current bytes");
    expect(await fsp.readFile(pending, "utf8")).toBe(
      JSON.stringify({ version: 0 }),
    );
  });
});

describe("project operation serialization", () => {
  it("captures a complete external mutation and orders following writes across instances", async () => {
    const first = service();
    const second = service();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = first.withProjectOperation(async () => {
      await fsp.writeFile(
        path.join(first.filesRoot, "first.txt"),
        "first half",
      );
      entered.resolve();
      await release.promise;
      await fsp.writeFile(
        path.join(first.filesRoot, "second.txt"),
        "second half",
      );
    });
    await entered.promise;
    const snapshot = second.createSnapshot();
    const write = first.writeFile("later.txt", "after capture");
    release.resolve();
    await writer;
    const saved = await snapshot;
    await write;
    expect(
      (await second.exportFiles(saved.id)).map((file) => [
        file.path,
        file.bytes.toString(),
      ]),
    ).toEqual([
      ["/first.txt", "first half"],
      ["/second.txt", "second half"],
    ]);
    expect(await first.readFile("later.txt")).toBe("after capture");
  });

  it("orders a real Git writer and builtin shell mkdir with snapshots", async () => {
    const vfs = service();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = vfs.withProjectOperation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const git = createVfsGitService(service()).run({ action: "init" });
    const snapshot = service().createSnapshot();
    const shell = runVfsBuiltinShell({
      cwdUri: `vfs://${projectId}/`,
      command: "mkdir",
      args: ["-p", "shell/nested"],
    });
    release.resolve();
    await blocker;
    await git;
    const saved = await snapshot;
    expect(
      (await service().exportFiles(saved.id)).some(
        (file) =>
          file.path === "/.git/HEAD" &&
          file.bytes.toString().includes("refs/heads/main"),
      ),
    ).toBe(true);
    expect(await shell).toMatchObject({ exitCode: 0 });
    expect(
      (await vfs.list("shell")).map((entry) => [entry.path, entry.type]),
    ).toEqual([["/shell/nested", "directory"]]);
  });
});
