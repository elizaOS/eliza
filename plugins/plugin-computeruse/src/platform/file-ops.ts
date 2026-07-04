/**
 * Internal file primitives (read/write/list) behind path-security checks. Not
 * exposed as an agent action — the FILE action owns user-facing file access;
 * these back internal computer-use flows only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FileActionResult, FileEntry } from "../types.js";
import { resolveSafeFileTarget } from "./security.js";

export async function readFile(
  targetPath: string,
  encoding: BufferEncoding = "utf8",
): Promise<FileActionResult> {
  const check = await resolveSafeFileTarget(targetPath, "read");
  if (!check.allowed || !check.resolvedPath) {
    return { success: false, error: check.reason ?? "Path not allowed." };
  }

  try {
    const content = await fs.readFile(check.resolvedPath, { encoding });
    return {
      success: true,
      path: check.resolvedPath,
      content: String(content).slice(0, 10000),
    };
  } catch (error) {
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
    await fs.mkdir(path.dirname(check.resolvedPath), { recursive: true });
    await fs.writeFile(check.resolvedPath, content, "utf8");
    return {
      success: true,
      path: check.resolvedPath,
      message: "File written.",
    };
  } catch (error) {
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
    const content = await fs.readFile(check.resolvedPath, "utf8");
    if (!content.includes(oldText)) {
      return {
        success: false,
        error: "Old text not found in file.",
      };
    }
    await fs.writeFile(
      check.resolvedPath,
      content.replace(oldText, newText),
      "utf8",
    );
    return {
      success: true,
      path: check.resolvedPath,
      message: "File edited.",
    };
  } catch (error) {
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
    await fs.mkdir(path.dirname(check.resolvedPath), { recursive: true });
    await fs.appendFile(check.resolvedPath, content, "utf8");
    return {
      success: true,
      path: check.resolvedPath,
      message: "Content appended.",
    };
  } catch (error) {
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
  } catch {
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
  try {
    let buf = await fs.readFile(check.resolvedPath);
    if (typeof offset === "number" || typeof length === "number") {
      const start = Math.max(0, Math.floor(offset ?? 0));
      const end =
        typeof length === "number"
          ? start + Math.max(0, Math.floor(length))
          : undefined;
      buf = buf.subarray(start, end);
    }
    return {
      success: true,
      path: check.resolvedPath,
      bytes: buf.toString("base64"),
      size: buf.length,
    };
  } catch (error) {
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
    const buf = Buffer.from(base64 ?? "", "base64");
    await fs.mkdir(path.dirname(check.resolvedPath), { recursive: true });
    await fs.writeFile(check.resolvedPath, buf);
    return {
      success: true,
      path: check.resolvedPath,
      size: buf.length,
      message: `Wrote ${buf.length} bytes.`,
    };
  } catch (error) {
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
  } catch {
    return {
      success: true,
      path: check.resolvedPath,
      exists: false,
      is_directory: false,
      isDirectory: false,
    };
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
    return fileOpError(error);
  }
}
