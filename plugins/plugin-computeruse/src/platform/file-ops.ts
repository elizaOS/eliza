/**
 * Internal file primitives (read/write/list) behind path-security checks. Not
 * exposed as an agent action — the FILE action owns user-facing file access;
 * these back internal computer-use flows only.
 *
 * Byte-bearing reads and writes fail closed before allocating more than
 * {@link MAX_FILE_OP_BYTES}. `readFile` still returns at most
 * {@link READ_FILE_CHAR_LIMIT} characters, but it no longer slurp-then-slices
 * the whole guest file first. Edit/append budget against the size observed on
 * the opened handle; they do not lock out a concurrent writer.
 */
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileActionResult, FileEntry } from "../types.js";
import { resolveSafeFileTarget } from "./security.js";

/** Same working-set ceiling as the clipboard path (`CLIPBOARD_MAX_BYTES`). */
export const MAX_FILE_OP_BYTES = 10 * 1024 * 1024;
export const READ_FILE_CHAR_LIMIT = 10_000;

type ReadableFileHandle = Pick<FileHandle, "read">;

/**
 * Decoded-byte ceiling for Node `Buffer.from(..., "base64")`, including
 * unpadded input. Never underestimates: leftover 2 chars → 1 byte, leftover 3
 * → 2 bytes, leftover 1 (invalid) still counts 1 so a cap+1 payload cannot
 * sneak past the pre-decode check.
 */
export function decodedBase64Budget(encoded: string): number {
  let n = encoded.length;
  while (n > 0 && encoded.charCodeAt(n - 1) === 0x3d) n -= 1;
  const rem = n % 4;
  return Math.floor(n / 4) * 3 + (rem === 0 ? 0 : rem === 3 ? 2 : 1);
}

function budgetExceeded(op: string): FileActionResult {
  return {
    success: false,
    error: `${op} exceeds the ${MAX_FILE_OP_BYTES}-byte file-op budget.`,
  };
}

function invalidByteCount(name: string): FileActionResult {
  return {
    success: false,
    error: `${name} must be a non-negative safe integer.`,
  };
}

function parseByteCount(
  value: unknown,
  name: string,
): { ok: true; value?: number } | { ok: false; result: FileActionResult } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { ok: false, result: invalidByteCount(name) };
  }
  return { ok: true, value };
}

/**
 * Fill `take` bytes from `start`, looping on short reads. Returns a slice of
 * the bytes actually obtained (EOF stops the loop).
 */
export async function readExactWindowFromHandle(
  handle: ReadableFileHandle,
  start: number,
  take: number,
): Promise<Buffer> {
  if (take === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(take);
  let filled = 0;
  while (filled < take) {
    const { bytesRead } = await handle.read(
      buf,
      filled,
      take - filled,
      start + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === take ? buf : buf.subarray(0, filled);
}

export async function readFile(
  targetPath: string,
  encoding: BufferEncoding = "utf8",
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "read");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    const handle = await fs.open(check.resolvedPath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return { success: false, error: "Path is not a regular file." };
      }
      const maxBytes = READ_FILE_CHAR_LIMIT * 4;
      const take = Math.min(stat.size, maxBytes);
      const buf = await readExactWindowFromHandle(handle, 0, take);
      return {
        success: true,
        path: check.resolvedPath,
        content: buf.toString(encoding).slice(0, READ_FILE_CHAR_LIMIT),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function writeFile(
  targetPath: string,
  content: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "write");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_OP_BYTES) {
      return budgetExceeded("write");
    }
    await fs.mkdir(path.dirname(check.resolvedPath), { recursive: true });
    await fs.writeFile(check.resolvedPath, content, "utf8");
    return {
      success: true,
      path: check.resolvedPath,
      message: "File written.",
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function editFile(
  targetPath: string,
  oldText: string,
  newText: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "write");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    const handle = await fs.open(check.resolvedPath, "r+");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return { success: false, error: "Path is not a regular file." };
      }
      const take = Math.min(stat.size, MAX_FILE_OP_BYTES + 1);
      const buf = await readExactWindowFromHandle(handle, 0, take);
      if (buf.length > MAX_FILE_OP_BYTES) {
        return budgetExceeded("edit");
      }
      const content = buf.toString("utf8");
      if (!content.includes(oldText)) {
        return {
          success: false,
          error: "Old text not found in file.",
        };
      }
      const next = content.replace(oldText, newText);
      if (Buffer.byteLength(next, "utf8") > MAX_FILE_OP_BYTES) {
        return budgetExceeded("edit");
      }
      await handle.truncate(0);
      await handle.write(next, 0, "utf8");
      return {
        success: true,
        path: check.resolvedPath,
        message: "File edited.",
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function appendFile(
  targetPath: string,
  content: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "write");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    const incoming = Buffer.byteLength(content, "utf8");
    if (incoming > MAX_FILE_OP_BYTES) {
      return budgetExceeded("append");
    }
    await fs.mkdir(path.dirname(check.resolvedPath), { recursive: true });
    const handle = await fs.open(check.resolvedPath, "a");
    try {
      const existing = (await handle.stat()).size;
      if (existing + incoming > MAX_FILE_OP_BYTES) {
        return budgetExceeded("append");
      }
      await handle.write(content, null, "utf8");
    } finally {
      await handle.close();
    }
    return {
      success: true,
      path: check.resolvedPath,
      message: "Content appended.",
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function deleteFile(
  targetPath: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "delete");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    await fs.unlink(check.resolvedPath);
    return {
      success: true,
      path: check.resolvedPath,
      message: "File deleted.",
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fileExists(
  targetPath: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "read");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    await fs.access(check.resolvedPath);
    const stat = await fs.stat(check.resolvedPath);
    return {
      success: true,
      path: check.resolvedPath,
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      is_file: stat.isFile(),
      is_directory: stat.isDirectory(),
      size: stat.size,
    };
  } catch (error) {
    // error-policy:J3 existence probe with errno narrowing — only an
    // expected miss (ENOENT/ENOTDIR) reads as "does not exist"; permission
    // and I/O failures surface as a structured failure instead of a
    // fabricated "absent".
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        success: true,
        path: check.resolvedPath,
        exists: false,
        isFile: false,
        isDirectory: false,
        is_file: false,
        is_directory: false,
        size: 0,
      };
    }
    return fileOpError(error);
  }
}

export async function listDirectory(
  targetPath: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "read");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }
  const resolvedPath = check.resolvedPath;

  try {
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const items: FileEntry[] = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      path: path.join(resolvedPath, entry.name),
    }));
    return {
      success: true,
      path: resolvedPath,
      items,
      count: items.length,
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function deleteDirectory(
  targetPath: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "delete");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    await fs.rm(check.resolvedPath, { recursive: true, force: true });
    return {
      success: true,
      path: check.resolvedPath,
      message: "Directory deleted.",
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function fileOpError(error: unknown): FileActionResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Read raw bytes as base64 (#9170 — cua `read_bytes`). Optional byte `offset` /
 * `length` window for chunked transfer of a sandbox guest file. Unlike `readFile`
 * (text, truncated to 10k chars) this is binary-safe and returns the exact bytes.
 */
export async function readBytes(
  targetPath: string,
  offset?: number,
  length?: number,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "read");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }
  const parsedOffset = parseByteCount(offset, "offset");
  if (!parsedOffset.ok) return parsedOffset.result;
  const parsedLength = parseByteCount(length, "length");
  if (!parsedLength.ok) return parsedLength.result;
  try {
    const handle = await fs.open(check.resolvedPath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return { success: false, error: "Path is not a regular file." };
      }
      const start = parsedOffset.value ?? 0;
      const remaining = Math.max(0, stat.size - start);
      const take =
        parsedLength.value === undefined
          ? remaining
          : Math.min(parsedLength.value, remaining);
      if (take > MAX_FILE_OP_BYTES) {
        return budgetExceeded("read_bytes");
      }
      const buf = await readExactWindowFromHandle(handle, start, take);
      return {
        success: true,
        path: check.resolvedPath,
        bytes: buf.toString("base64"),
        size: buf.length,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return fileOpError(error);
  }
}

/**
 * Write base64-encoded bytes to a file (#9170 — cua `write_bytes`), creating
 * parent directories. Binary-safe counterpart to `writeFile`.
 */
export async function writeBytes(
  targetPath: string,
  base64: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "write");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }
  try {
    const encoded = base64 ?? "";
    if (decodedBase64Budget(encoded) > MAX_FILE_OP_BYTES) {
      return budgetExceeded("write_bytes");
    }
    const buf = Buffer.from(encoded, "base64");
    if (buf.length > MAX_FILE_OP_BYTES) {
      return budgetExceeded("write_bytes");
    }
    await fs.mkdir(path.dirname(check.resolvedPath), { recursive: true });
    await fs.writeFile(check.resolvedPath, buf);
    return {
      success: true,
      path: check.resolvedPath,
      size: buf.length,
      message: `Wrote ${buf.length} bytes.`,
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return fileOpError(error);
  }
}

/** Create a directory (recursive) (#9170 — cua `create_dir`). */
export async function createDirectory(
  targetPath: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "write");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }
  try {
    await fs.mkdir(check.resolvedPath, { recursive: true });
    return {
      success: true,
      path: check.resolvedPath,
      is_directory: true,
      isDirectory: true,
      message: "Directory created.",
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return fileOpError(error);
  }
}

/** Whether a path exists AND is a directory (#9170 — cua `directory_exists`). */
export async function directoryExists(
  targetPath: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "read");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }
  try {
    const stat = await fs.stat(check.resolvedPath);
    const isDir = stat.isDirectory();
    return {
      success: true,
      path: check.resolvedPath,
      exists: isDir,
      is_directory: isDir,
      isDirectory: isDir,
    };
  } catch (error) {
    // error-policy:J3 existence probe with errno narrowing — only an
    // expected miss (ENOENT/ENOTDIR) reads as "does not exist"; permission
    // and I/O failures surface as a structured failure instead of a
    // fabricated "absent".
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        success: true,
        path: check.resolvedPath,
        exists: false,
        is_directory: false,
        isDirectory: false,
      };
    }
    return fileOpError(error);
  }
}

/** File/dir size in bytes (#9170 — cua `get_file_size`). */
export async function getFileSize(
  targetPath: string,
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "read");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }
  try {
    const stat = await fs.stat(check.resolvedPath);
    return {
      success: true,
      path: check.resolvedPath,
      size: stat.size,
      is_file: stat.isFile(),
      isFile: stat.isFile(),
      is_directory: stat.isDirectory(),
      isDirectory: stat.isDirectory(),
    };
  } catch (error) {
    // error-policy:J1 file-op boundary — the failure returns as a structured
    // {success:false,error} the action surfaces to the model.
    return fileOpError(error);
  }
}
