/**
 * Regression coverage for elizaOS/eliza#29714: listSnapshots must return a
 * total order even when a persisted snapshot.json carries an unparseable
 * createdAt. Drives the real VirtualFilesystemService against a real
 * temporary directory — no stubbed sorter and no comparator re-implemented
 * in the test body.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VirtualFilesystemService,
} from "./virtual-filesystem.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-vfs-sort-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function service(now: () => Date): VirtualFilesystemService {
  return new VirtualFilesystemService({
    projectId: "agent-safe-mode",
    stateDir: tmpDir,
    now,
  });
}

/** Simulate a corrupted/truncated/hand-edited snapshot.json on disk. */
async function corruptCreatedAt(
  vfs: VirtualFilesystemService,
  id: string,
): Promise<void> {
  const metadataPath = path.join(vfs.snapshotsRoot, id, "snapshot.json");
  const metadata = JSON.parse(await fsp.readFile(metadataPath, "utf-8"));
  metadata.createdAt = "not-a-date";
  await fsp.writeFile(metadataPath, JSON.stringify(metadata), "utf-8");
}

describe("VirtualFilesystemService.listSnapshots ordering", () => {
  it("keeps valid snapshots newest-first and sorts unparseable dates last", async () => {
    const clock = { value: new Date("2026-01-01T00:00:00.000Z") };
    const vfs = service(() => clock.value);
    await vfs.initialize();

    const first = await vfs.createSnapshot("first"); // 2026-01-01
    clock.value = new Date("2026-01-02T00:00:00.000Z");
    const second = await vfs.createSnapshot("second"); // 2026-01-02
    clock.value = new Date("2026-01-03T00:00:00.000Z");
    const third = await vfs.createSnapshot("third"); // 2026-01-03 (newest)

    // Corrupt the oldest snapshot's persisted createdAt, as a truncated or
    // hand-edited metadata file would. One unreadable file must not reorder
    // the valid entries around it.
    await corruptCreatedAt(vfs, first.id);

    const listed = await vfs.listSnapshots();

    // The valid snapshots keep their correct newest-first relative order...
    expect(
      listed.filter((snapshot) => snapshot.id !== first.id).map((s) => s.id),
    ).toEqual([third.id, second.id]);

    // ...and the unparseable one sorts last.
    expect(listed.map((snapshot) => snapshot.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
  });

  it("stays total when multiple snapshots have unparseable dates", async () => {
    const clock = { value: new Date("2026-01-01T00:00:00.000Z") };
    const vfs = service(() => clock.value);
    await vfs.initialize();

    const first = await vfs.createSnapshot("first"); // 2026-01-01
    clock.value = new Date("2026-01-02T00:00:00.000Z");
    const second = await vfs.createSnapshot("second"); // 2026-01-02
    clock.value = new Date("2026-01-03T00:00:00.000Z");
    const third = await vfs.createSnapshot("third"); // 2026-01-03
    clock.value = new Date("2026-01-04T00:00:00.000Z");
    const fourth = await vfs.createSnapshot("fourth"); // 2026-01-04 (newest)

    await corruptCreatedAt(vfs, first.id);
    await corruptCreatedAt(vfs, fourth.id);

    const listed = await vfs.listSnapshots();

    // Valid snapshots keep their correct relative order.
    expect(
      listed
        .filter(
          (snapshot) =>
            snapshot.id !== first.id && snapshot.id !== fourth.id,
        )
        .map((s) => s.id),
    ).toEqual([third.id, second.id]);

    // Both unparseable snapshots land after every valid one.
    expect(listed.slice(-2).map((s) => s.id).sort()).toEqual(
      [first.id, fourth.id].sort(),
    );
  });
});
