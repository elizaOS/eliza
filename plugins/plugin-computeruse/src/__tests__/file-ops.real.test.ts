/**
 * Real integration tests for file operations.
 * Uses temp directories — no mocks needed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFile,
  deleteFile,
  editFile,
  fileExists,
  listDirectory,
  readFile,
  writeFile,
} from "../platform/file-ops.js";

describe("file operations (real)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "computeruse-fileops-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("readFile", () => {
    it("reads an existing file", async () => {
      const filePath = join(tempDir, "test.txt");
      writeFileSync(filePath, "hello world");

      const result = await readFile(filePath);
      expect(result.success).toBe(true);
      expect(result.content).toBe("hello world");
    });

    it("returns error for non-existent file", async () => {
      const result = await readFile(join(tempDir, "nope.txt"));
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("writeFile", () => {
    it("creates a new file", async () => {
      const filePath = join(tempDir, "new.txt");
      const result = await writeFile(filePath, "new content");
      expect(result.success).toBe(true);

      const read = await readFile(filePath);
      expect(read.content).toBe("new content");
    });

    it("creates parent directories", async () => {
      const filePath = join(tempDir, "sub", "dir", "deep.txt");
      const result = await writeFile(filePath, "deep");
      expect(result.success).toBe(true);
    });

    it("overwrites existing file", async () => {
      const filePath = join(tempDir, "overwrite.txt");
      writeFileSync(filePath, "old");
      await writeFile(filePath, "new");

      const read = await readFile(filePath);
      expect(read.content).toBe("new");
    });
  });

  describe("editFile", () => {
    it("replaces text in a file", async () => {
      const filePath = join(tempDir, "edit.txt");
      writeFileSync(filePath, "hello world");

      const result = await editFile(filePath, "world", "universe");
      expect(result.success).toBe(true);

      const read = await readFile(filePath);
      expect(read.content).toBe("hello universe");
    });

    it("returns error when old text not found", async () => {
      const filePath = join(tempDir, "edit2.txt");
      writeFileSync(filePath, "hello");

      const result = await editFile(filePath, "missing", "replacement");
      expect(result.success).toBe(false);
    });
  });

  describe("appendFile", () => {
    it("appends content to a file", async () => {
      const filePath = join(tempDir, "append.txt");
      writeFileSync(filePath, "line1\n");

      const result = await appendFile(filePath, "line2\n");
      expect(result.success).toBe(true);

      const read = await readFile(filePath);
      expect(read.content).toBe("line1\nline2\n");
    });
  });

  describe("deleteFile", () => {
    it("deletes an existing file", async () => {
      const filePath = join(tempDir, "delete.txt");
      writeFileSync(filePath, "delete me");

      const result = await deleteFile(filePath);
      expect(result.success).toBe(true);

      const exists = await fileExists(filePath);
      expect(exists.exists).toBe(false);
    });
  });

  describe("fileExists", () => {
    it("detects existing file", async () => {
      const filePath = join(tempDir, "exists.txt");
      writeFileSync(filePath, "hi");

      const result = await fileExists(filePath);
      expect(result.exists).toBe(true);
      expect(result.isFile).toBe(true);
      expect(result.isDirectory).toBe(false);
    });

    it("detects existing directory", async () => {
      const dirPath = join(tempDir, "subdir");
      mkdirSync(dirPath);

      const result = await fileExists(dirPath);
      expect(result.exists).toBe(true);
      expect(result.isDirectory).toBe(true);
    });

    it("returns exists=false for non-existent path", async () => {
      const result = await fileExists(join(tempDir, "nope"));
      expect(result.exists).toBe(false);
    });
  });

  describe("listDirectory", () => {
    it("lists directory contents", async () => {
      writeFileSync(join(tempDir, "a.txt"), "a");
      writeFileSync(join(tempDir, "b.txt"), "b");
      mkdirSync(join(tempDir, "subdir"));

      const result = await listDirectory(tempDir);
      expect(result.success).toBe(true);
      expect(result.items).toBeDefined();
      expect(result.items!.length).toBeGreaterThanOrEqual(3);

      const names = result.items!.map((e) => e.name);
      expect(names).toContain("a.txt");
      expect(names).toContain("b.txt");
      expect(names).toContain("subdir");

      const subdir = result.items!.find((e) => e.name === "subdir");
      expect(subdir?.type).toBe("directory");
    });
  });
});
