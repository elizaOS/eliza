/** Concurrent writes and snapshots exercise the real in-memory VFS. */
import { expect, it } from "vitest";
import { MemoryMobileSafeVirtualFileSystem } from "./mobile-safe-runtime";

it("admits concurrent writes atomically against the quota", async () => {
  const files = new MemoryMobileSafeVirtualFileSystem({ quotaBytes: 3 });
  const outcomes = await Promise.allSettled([
    files.writeFile("/a", new Uint8Array(2)),
    files.writeFile("/b", new Uint8Array(2)),
  ]);
  expect(outcomes.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(await files.quota()).toMatchObject({ usedBytes: 2, fileCount: 1 });
  expect(await files.stat("/b")).toBeNull();
});

it("captures file contents and metadata from the same instant", async () => {
  const files = new MemoryMobileSafeVirtualFileSystem();
  await files.writeFile("/before", new Uint8Array(2));
  const pending = files.createSnapshot();
  await files.writeFile("/after", new Uint8Array(3));
  const snapshot = await pending;
  expect(snapshot).toMatchObject({ fileCount: 1, filesBytes: 2 });
  await files.rollback(snapshot.id);
  expect(await files.quota()).toMatchObject({ fileCount: 1, usedBytes: 2 });
  expect(await files.stat("/after")).toBeNull();
});

it("rejects file and directory collisions without changing stored bytes", async () => {
  const files = new MemoryMobileSafeVirtualFileSystem();
  await files.writeFile("/file", new Uint8Array([7]));
  await expect(files.mkdir("/file/child")).rejects.toThrow("over a file");
  await expect(
    files.writeFile("/file/child", new Uint8Array(1)),
  ).rejects.toThrow("over a file");
  await expect(files.writeFile("/", new Uint8Array(1))).rejects.toThrow(
    "over a directory",
  );
  expect(await files.readFile("/file")).toEqual(new Uint8Array([7]));
  expect(await files.list("/")).toHaveLength(1);
});

it.each([NaN, Infinity, -1, 1.5])("rejects invalid quota %s", (quotaBytes) => {
  expect(() => new MemoryMobileSafeVirtualFileSystem({ quotaBytes })).toThrow(
    "non-negative safe integer",
  );
});
