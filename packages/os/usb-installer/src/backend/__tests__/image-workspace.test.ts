import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withTemporaryImageDirectory } from "../image-workspace";

it("isolates concurrent image operations and cleans only after settlement", async () => {
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const directories: string[] = [];
  const operations = [1, 2].map(() =>
    withTemporaryImageDirectory(async (directory) => {
      directories.push(directory);
      await writeFile(join(directory, "image.partial"), "fixture");
      if (process.platform !== "win32")
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      if (directories.length === 2) finish();
      await barrier;
      expect((await stat(join(directory, "image.partial"))).isFile()).toBe(
        true,
      );
      return directory;
    }),
  );
  const results = await Promise.all(operations);
  expect(new Set(results).size).toBe(2);
  for (const directory of results)
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("cleans failed writes while preserving their error", async () => {
  const failure = new Error("write failed");
  let location = "";
  await expect(
    withTemporaryImageDirectory(async (directory) => {
      location = directory;
      await writeFile(join(directory, "image.partial"), "partial");
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(stat(location)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
  "preserves both write and cleanup errors",
  async () => {
    const failure = new Error("write failed");
    let location = "";
    let locked = "";
    try {
      await expect(
        withTemporaryImageDirectory(async (directory) => {
          location = directory;
          locked = join(directory, "locked");
          await mkdir(locked);
          await writeFile(join(locked, "partial"), "partial");
          await chmod(locked, 0o500);
          throw failure;
        }),
      ).rejects.toMatchObject({ errors: [failure, { code: "EACCES" }] });
    } finally {
      if (locked) await chmod(locked, 0o700);
      if (location) await rm(location, { recursive: true, force: true });
    }
  },
);
