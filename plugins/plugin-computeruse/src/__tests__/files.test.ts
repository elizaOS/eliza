import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFile,
  deleteDirectory,
  deleteFile,
  fileDownload,
  fileExists,
  fileListDownloads,
  fileUpload,
  listDirectory,
  readFile,
  writeFile,
  editFile,
} from "../platform/files.js";

describe("file platform", () => {
  let rootDir: string | null = null;

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  it("writes, reads, edits, appends, and deletes files", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "computeruse-files-"));
    const filePath = join(rootDir, "nested", "note.txt");

    const written = await writeFile({ path: filePath, content: "alpha" });
    expect(written.success).toBe(true);

    const read = await readFile({ path: filePath });
    expect(read.success).toBe(true);
    expect(String(read.content ?? "")).toBe("alpha");

    const edited = await editFile({ path: filePath, old_text: "alpha", new_text: "beta" });
    expect(edited.success).toBe(true);

    const appended = await appendFile({ path: filePath, content: "\ngamma" });
    expect(appended.success).toBe(true);

    const aliasRead = await fileDownload({ path: filePath });
    expect(aliasRead.success).toBe(true);
    expect(String(aliasRead.content ?? "")).toContain("beta");
    expect(String(aliasRead.content ?? "")).toContain("gamma");

    const exists = await fileExists({ path: filePath });
    expect(exists.success).toBe(true);
    expect(exists.exists).toBe(true);

    const removed = await deleteFile({ path: filePath });
    expect(removed.success).toBe(true);

    const missing = await fileExists({ path: filePath });
    expect(missing.success).toBe(true);
    expect(missing.exists).toBe(false);
  });

  it("lists directories and supports directory aliases", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "computeruse-dirs-"));
    const childDir = join(rootDir, "child");
    const childFile = join(rootDir, "file.txt");

    await writeFile({ path: childFile, content: "hello" });
    await writeFile({ path: join(childDir, "inner.txt"), content: "inner" });

    const listed = await listDirectory({ path: rootDir });
    expect(listed.success).toBe(true);
    expect(Array.isArray(listed.items)).toBe(true);
    expect(Number(listed.count)).toBeGreaterThanOrEqual(2);

    const upload = await fileUpload({ path: join(rootDir, "upload.txt"), content: "upload" });
    expect(upload.success).toBe(true);

    const aliasList = await fileListDownloads({ path: rootDir });
    expect(aliasList.success).toBe(true);

    const deleted = await deleteDirectory({ path: childDir });
    expect(deleted.success).toBe(true);
  });

  it("blocks unsafe root writes and deletes", async () => {
    const unsafePath = process.platform === "win32" ? "C:\\" : "/";
    const write = await writeFile({ path: unsafePath, content: "nope" });
    const remove = await deleteDirectory({ path: unsafePath });

    expect(write.success).toBe(false);
    expect(remove.success).toBe(false);
  });
});

