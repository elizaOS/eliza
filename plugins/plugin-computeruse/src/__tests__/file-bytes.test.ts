/**
 * Binary filesystem primitives (#9170 — trycua/cua read_bytes / write_bytes /
 * create_dir / directory_exists / get_file_size). Pure Node fs over the safe-path
 * guard, so this runs in the DEFAULT lane on Windows / Linux / macOS alike.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDirectory,
  directoryExists,
  getFileSize,
  readBytes,
  writeBytes,
} from "../platform/file-ops.js";

describe("binary file ops (read_bytes / write_bytes)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cu-bytes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips arbitrary bytes (incl. non-UTF8) via base64", async () => {
    const raw = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0xfe, 0x01]);
    const b64 = raw.toString("base64");
    const file = join(dir, "blob.bin");

    const w = await writeBytes(file, b64);
    expect(w.success).toBe(true);
    expect(w.size).toBe(raw.length);

    const r = await readBytes(file);
    expect(r.success).toBe(true);
    expect(r.size).toBe(raw.length);
    expect(Buffer.from(r.bytes ?? "", "base64").equals(raw)).toBe(true);
  });

  it("reads a byte window with offset + length", async () => {
    const raw = Buffer.from([10, 11, 12, 13, 14, 15]);
    const file = join(dir, "win.bin");
    await writeBytes(file, raw.toString("base64"));

    const r = await readBytes(file, 2, 3);
    expect(r.success).toBe(true);
    expect(
      Buffer.from(r.bytes ?? "", "base64").equals(Buffer.from([12, 13, 14])),
    ).toBe(true);
  });

  it("write_bytes creates parent directories", async () => {
    const file = join(dir, "a", "b", "c.bin");
    const w = await writeBytes(file, Buffer.from([1, 2, 3]).toString("base64"));
    expect(w.success).toBe(true);
    const r = await readBytes(file);
    expect(r.size).toBe(3);
  });
});

describe("create_dir / directory_exists / get_file_size", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cu-fs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("create_dir makes a (recursive) directory; directory_exists confirms it", async () => {
    const sub = join(dir, "x", "y", "z");
    const c = await createDirectory(sub);
    expect(c.success).toBe(true);
    expect(c.is_directory).toBe(true);

    const d = await directoryExists(sub);
    expect(d.success).toBe(true);
    expect(d.exists).toBe(true);
    expect(d.is_directory).toBe(true);
  });

  it("directory_exists is false for a missing path and for a regular file", async () => {
    const missing = await directoryExists(join(dir, "nope"));
    expect(missing.exists).toBe(false);

    const file = join(dir, "f.bin");
    await writeBytes(file, Buffer.from([9]).toString("base64"));
    const onFile = await directoryExists(file);
    expect(onFile.exists).toBe(false);
    expect(onFile.is_directory).toBe(false);
  });

  it("get_file_size returns the byte length of a file", async () => {
    const file = join(dir, "sz.bin");
    const raw = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await writeBytes(file, raw.toString("base64"));
    const s = await getFileSize(file);
    expect(s.success).toBe(true);
    expect(s.size).toBe(raw.length);
    expect(s.is_file).toBe(true);
  });
});
