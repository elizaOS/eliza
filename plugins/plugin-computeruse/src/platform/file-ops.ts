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

  try {
    const entries = await fs.readdir(check.resolvedPath, { withFileTypes: true });
    const items: FileEntry[] = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      path: path.join(check.resolvedPath, entry.name),
    }));
    return {
      success: true,
      path: check.resolvedPath,
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
