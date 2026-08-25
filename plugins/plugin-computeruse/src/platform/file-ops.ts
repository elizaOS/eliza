/**
 * Internal file primitives (read/write/list) behind path-security checks. Not
 * exposed as an agent action — the FILE action owns user-facing file access;
 * these back internal computer-use flows only.
 *
 * Byte-bearing reads and writes fail closed before allocating more than
 * {@link MAX_FILE_OP_BYTES}. Text reads return the complete file or fail the
 * same byte budget without changing the content. Mutating read-modify-write
 * operations keep one file handle so a path replacement cannot redirect the
 * eventual write.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FileActionResult, FileEntry } from "../types.js";
import { resolveSafeFileTarget } from "./security.js";

/** Same working-set ceiling as the clipboard path (`CLIPBOARD_MAX_BYTES`). */
export const MAX_FILE_OP_BYTES = 10 * 1024 * 1024;

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

type WindowReadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; result: FileActionResult };

async function readBoundedWindowFromHandle(
  handle: Awaited<ReturnType<typeof fs.open>>,
  start: number,
  requestedLength: number | undefined,
  op: string,
): Promise<WindowReadResult> {
  const stat = await handle.stat();
  if (!stat.isFile()) {
    return {
      ok: false,
      result: { success: false, error: "Path is not a regular file." },
    };
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    return { ok: false, result: budgetExceeded(op) };
  }

  const remaining = Math.max(0, stat.size - start);
  const take =
    requestedLength === undefined
      ? remaining
      : Math.min(requestedLength, remaining);
  if (take > MAX_FILE_OP_BYTES) {
    return { ok: false, result: budgetExceeded(op) };
  }

  const buffer = Buffer.allocUnsafe(take);
  let total = 0;
  while (total < take) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      take - total,
      start + total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return {
    ok: true,
    buffer: total === buffer.length ? buffer : buffer.subarray(0, total),
  };
}

async function readBoundedWindow(
  resolvedPath: string,
  start: number,
  requestedLength: number | undefined,
  op: string,
): Promise<WindowReadResult> {
  const handle = await fs.open(resolvedPath, "r");
  try {
    return await readBoundedWindowFromHandle(
      handle,
      start,
      requestedLength,
      op,
    );
  } finally {
    await handle.close();
  }
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
    const read = await readBoundedWindow(
      check.resolvedPath,
      0,
      undefined,
      "read",
    );
    if (!read.ok) return read.result;
    return {
      success: true,
      path: check.resolvedPath,
      content: read.buffer.toString(encoding),
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
      const read = await readBoundedWindowFromHandle(
        handle,
        0,
        undefined,
        "edit",
      );
      if (!read.ok) return read.result;
      const content = read.buffer.toString("utf8");
      if (!content.includes(oldText)) {
        return {
          success: false,
          error: "Old text not found in file.",
        };
      }
      const matchIndex = content.indexOf(oldText);
      const prefix = content.slice(0, matchIndex);
      const suffix = content.slice(matchIndex + oldText.length);
      const nextBytes =
        Buffer.byteLength(prefix, "utf8") +
        Buffer.byteLength(newText, "utf8") +
        Buffer.byteLength(suffix, "utf8");
      if (nextBytes > MAX_FILE_OP_BYTES) {
        return budgetExceeded("edit");
      }
      // Assemble a literal replacement only after its encoded size is known.
      // String.replace interprets replacement tokens that can amplify a
      // bounded input into an enormous allocation.
      const next = `${prefix}${newText}${suffix}`;
      await handle.truncate(0);
      await handle.writeFile(next, "utf8");
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
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return { success: false, error: "Path is not a regular file." };
      }
      if (
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size + incoming > MAX_FILE_OP_BYTES
      ) {
        return budgetExceeded("append");
      }
      await handle.writeFile(content, "utf8");
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
    const start = parsedOffset.value ?? 0;
    const read = await readBoundedWindow(
      check.resolvedPath,
      start,
      parsedLength.value,
      "read_bytes",
    );
    if (!read.ok) return read.result;
    return {
      success: true,
      path: check.resolvedPath,
      bytes: read.buffer.toString("base64"),
      size: read.buffer.length,
    };
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
    if (Buffer.byteLength(encoded, "base64") > MAX_FILE_OP_BYTES) {
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
