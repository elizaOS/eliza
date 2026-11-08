/** Snapshot retention: the oldest are pruned, the rollback target never is. */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

let stateDir: string | undefined;

afterEach(async () => {
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

async function newProject(maxSnapshots?: number) {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-snapshots-"));
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const vfs = new VirtualFilesystemService({
    projectId: "snapshots",
    stateDir,
    ...(maxSnapshots ? { maxSnapshots } : {}),
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  });
  await vfs.initialize();
  return vfs;
}

describe("VFS snapshot retention", () => {
  it("keeps the newest 20 of 25 snapshots", async () => {
    const vfs = await newProject();
    const created: string[] = [];
    for (let index = 0; index < 25; index++) {
      await vfs.writeFile("count.txt", String(index));
      created.push((await vfs.createSnapshot(`#${index}`)).id);
    }

    const kept = await vfs.listSnapshots();

    expect(kept.map((snapshot) => snapshot.id)).toEqual(
      created.slice(5).reverse(),
    );
    expect(await fsp.readdir(vfs.snapshotsRoot)).toHaveLength(20);
  });

  it("never prunes the snapshot being restored", async () => {
    const vfs = await newProject(3);
    await vfs.writeFile("state.txt", "original");
    const target = await vfs.createSnapshot("target");
    for (const value of ["second", "third"]) {
      await vfs.writeFile("state.txt", value);
      await vfs.createSnapshot(value);
    }

    const rollback = await vfs.rollback(target.id);

    expect(await vfs.readFile("state.txt")).toBe("original");
    const ids = (await vfs.listSnapshots()).map((snapshot) => snapshot.id);
    expect(ids).toContain(target.id);
    expect(ids).toContain(rollback.previousSnapshotId);
    expect(ids).toHaveLength(4);
  });
});
