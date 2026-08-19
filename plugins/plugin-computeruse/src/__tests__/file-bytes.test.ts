/**
 * Binary filesystem primitives (#9170 — trycua/cua read_bytes / write_bytes /
 * create_dir / directory_exists / get_file_size). Pure Node fs over the safe-path
 * guard, so this runs in the DEFAULT lane on Windows / Linux / macOS alike.
 *
 * Also covers the fail-before-allocate byte budget: origin `readBytes` slurped
 * the whole guest file before applying offset/length.
 */

import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDirectory,
  directoryExists,
  editFile,
  getFileSize,
  MAX_FILE_OP_BYTES,
  READ_FILE_CHAR_LIMIT,
  readBytes,
  readFile,
  writeBytes,
} from "../platform/file-ops.js";

function writeSparseFile(file: string, size: number): void {
  const fd = openSync(file, "w");
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

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

  it("rejects an unwindowed read larger than the file-op budget", async () => {
    const file = join(dir, "huge.bin");
    writeSparseFile(file, MAX_FILE_OP_BYTES + 1);
    const r = await readBytes(file);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/file-op budget/);
    expect(r.bytes).toBeUndefined();
  });

  it("reads a last-fit window from a file larger than the budget", async () => {
    const file = join(dir, "window.bin");
    writeSparseFile(file, MAX_FILE_OP_BYTES + 4096);
    const r = await readBytes(file, 0, MAX_FILE_OP_BYTES);
    expect(r.success).toBe(true);
    expect(r.size).toBe(MAX_FILE_OP_BYTES);
    expect(Buffer.from(r.bytes ?? "", "base64").length).toBe(MAX_FILE_OP_BYTES);
  });

  it("rejects the first overflowing window before allocating it", async () => {
    const file = join(dir, "overflow.bin");
    writeSparseFile(file, MAX_FILE_OP_BYTES + 4096);
    const r = await readBytes(file, 0, MAX_FILE_OP_BYTES + 1);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/file-op budget/);
    expect(r.bytes).toBeUndefined();
  });

  it("rejects hostile offset/length before any read", async () => {
    const file = join(dir, "hostile.bin");
    writeSparseFile(file, 64);
    for (const length of [
      Number.POSITIVE_INFINITY,
      1e20,
      -1,
      1.5,
      Number.NaN,
    ]) {
      const r = await readBytes(file, 0, length);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/non-negative safe integer/);
    }
  });

  it("rejects a write_bytes payload above the budget before decode-write", async () => {
    const file = join(dir, "too-big.bin");
    const encoded = Buffer.alloc(MAX_FILE_OP_BYTES + 1, 0x61).toString(
      "base64",
    );
    const w = await writeBytes(file, encoded);
    expect(w.success).toBe(false);
    expect(w.error).toMatch(/file-op budget/);
  });

  it("rejects an unpadded base64 payload above the budget", async () => {
    const file = join(dir, "too-big-unpadded.bin");
    const encoded = Buffer.alloc(MAX_FILE_OP_BYTES + 1, 0x61)
      .toString("base64")
      .replace(/=+$/, "");
    const w = await writeBytes(file, encoded);
    expect(w.success).toBe(false);
    expect(w.error).toMatch(/file-op budget/);
  });

  it("accepts a last-fit write_bytes payload", async () => {
    const file = join(dir, "fit.bin");
    const raw = Buffer.alloc(MAX_FILE_OP_BYTES, 0x62);
    const w = await writeBytes(file, raw.toString("base64"));
    expect(w.success).toBe(true);
    expect(w.size).toBe(MAX_FILE_OP_BYTES);
  });

  it("readFile returns at most 10000 chars from a sparse oversized file", async () => {
    const file = join(dir, "huge.txt");
    writeSparseFile(file, 8 * 1024 * 1024);
    const r = await readFile(file);
    expect(r.success).toBe(true);
    expect(r.content).toHaveLength(READ_FILE_CHAR_LIMIT);
  });

  it("treats edit replacement tokens literally", async () => {
    const file = join(dir, "replacement-tokens.txt");
    await writeBytes(file, Buffer.from("prefix old suffix").toString("base64"));

    const result = await editFile(file, "old", "$`-$&-$'");

    expect(result.success).toBe(true);
    const read = await readFile(file);
    expect(read.content).toBe("prefix $`-$&-$' suffix");
  });

  it("rejects an oversized edit replacement before assembling it", async () => {
    const file = join(dir, "oversized-edit.txt");
    await writeBytes(file, Buffer.from("old").toString("base64"));

    const result = await editFile(
      file,
      "old",
      "x".repeat(MAX_FILE_OP_BYTES + 1),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file-op budget/);
    const read = await readFile(file);
    expect(read.content).toBe("old");
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
