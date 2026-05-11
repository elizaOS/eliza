import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VirtualFilesystemError,
  VirtualFilesystemService,
} from "./virtual-filesystem.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-vfs-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function service(
  options: Partial<
    ConstructorParameters<typeof VirtualFilesystemService>[0]
  > = {},
) {
  return new VirtualFilesystemService({
    projectId: "agent-safe-mode",
    stateDir: tmpDir,
    quotaBytes: 1024,
    maxFileBytes: 512,
    ...options,
  });
}

describe("VirtualFilesystemService", () => {
  it("reads, writes, lists, and deletes files inside a project root", async () => {
    const vfs = service();
    await vfs.initialize();

    const written = await vfs.writeFile("notes/todo.txt", "ship safe mode");
    expect(written.path).toBe("/notes/todo.txt");
    expect(await vfs.readFile("/notes/todo.txt")).toBe("ship safe mode");

    const entries = await vfs.list("/", { recursive: true });
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["/notes", "directory"],
      ["/notes/todo.txt", "file"],
    ]);

    await vfs.delete("notes/todo.txt");
    await expect(vfs.readFile("notes/todo.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("blocks traversal and symlink escapes", async () => {
    const vfs = service();
    await vfs.initialize();

    await expect(vfs.writeFile("../escape.txt", "nope")).rejects.toBeInstanceOf(
      VirtualFilesystemError,
    );
    await expect(vfs.writeFile("../escape.txt", "nope")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL",
    });

    await fsp.symlink(tmpDir, path.join(vfs.filesRoot, "link-out"));
    await expect(vfs.readFile("link-out/secret.txt")).rejects.toMatchObject({
      code: "SYMLINK_DENIED",
    });
    await expect(
      vfs.writeFile("link-out/secret.txt", "nope"),
    ).rejects.toMatchObject({
      code: "SYMLINK_DENIED",
    });
    await expect(vfs.delete("link-out/secret.txt")).rejects.toMatchObject({
      code: "SYMLINK_DENIED",
    });
  });

  it("enforces per-file and project quotas", async () => {
    const vfs = service({ quotaBytes: 8, maxFileBytes: 5 });
    await vfs.initialize();

    await expect(vfs.writeFile("large.txt", "123456")).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });

    await vfs.writeFile("a.txt", "1234");
    await vfs.writeFile("b.txt", "1234");
    await expect(vfs.writeFile("c.txt", "1")).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });

    await expect(vfs.quota()).resolves.toMatchObject({
      usedBytes: 8,
      fileCount: 2,
      quotaBytes: 8,
      maxFileBytes: 5,
    });
  });

  it("creates snapshots and diffs current changes", async () => {
    const vfs = service();
    await vfs.initialize();
    await vfs.writeFile("a.txt", "one");
    await vfs.writeFile("delete-me.txt", "gone soon");
    const first = await vfs.createSnapshot("before edits");

    await vfs.writeFile("a.txt", "two");
    await vfs.writeFile("b.txt", "new");
    await vfs.delete("delete-me.txt");

    const diff = await vfs.diffCurrent(first.id);
    expect(diff.map((entry) => [entry.path, entry.status])).toEqual([
      ["/a.txt", "modified"],
      ["/b.txt", "added"],
      ["/delete-me.txt", "deleted"],
    ]);
  });

  it("rolls back to a snapshot and records rollback metadata", async () => {
    const vfs = service();
    await vfs.initialize();
    await vfs.writeFile("state.txt", "before");
    const snapshot = await vfs.createSnapshot();

    await vfs.writeFile("state.txt", "after");
    const rollback = await vfs.rollback(snapshot.id);

    expect(await vfs.readFile("state.txt")).toBe("before");
    expect(rollback.snapshotId).toBe(snapshot.id);
    expect(rollback.previousSnapshotId).toBeTruthy();

    const metadata = JSON.parse(
      await fsp.readFile(
        path.join(vfs.projectRoot, "last-rollback.json"),
        "utf-8",
      ),
    );
    expect(metadata).toMatchObject({
      snapshotId: snapshot.id,
      projectId: "agent-safe-mode",
    });
  });
});
