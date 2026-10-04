/**
 * Workbench snapshot lists are newest-first. Two snapshots saved in the same
 * millisecond must keep the higher id first.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPPER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SAME = "2026-08-20T16:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("virtual filesystem snapshot order", () => {
  it("lists the higher snapshot id first when createdAt matches", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "vfs-snapshots-"));
    directories.push(stateDir);
    const projectId = "workbench";
    const service = new VirtualFilesystemService({ stateDir, projectId });
    await service.initialize();

    for (const id of [LOWER, UPPER]) {
      const snapshotDir = path.join(service.snapshotsRoot, id);
      await mkdir(snapshotDir);
      await writeFile(
        path.join(snapshotDir, "snapshot.json"),
        JSON.stringify({
          id,
          projectId,
          createdAt: SAME,
          root: "files",
          filesBytes: 0,
          fileCount: 0,
        }),
      );
    }

    const snapshots = await service.listSnapshots();
    expect(snapshots.map((snapshot) => snapshot.id)).toEqual([UPPER, LOWER]);
  });
});
