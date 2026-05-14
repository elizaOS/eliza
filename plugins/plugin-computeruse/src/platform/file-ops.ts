import fs from "node:fs/promises";
import path from "node:path";
import type { FileActionResult, FileEntry } from "../types.js";
import { validateFilePath } from "./security.js";

export async function readFile(
  targetPath: string,
  encoding: BufferEncoding = "utf8",
): Promise<FileActionResult> {
  const check = validateFilePath(targetPath, "read");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    const content = await fs.readFile(targetPath, { encoding });
    return {
      success: true,
      path: targetPath,
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
  const check = validateFilePath(targetPath, "write");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
    return {
      success: true,
      path: targetPath,
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
  const check = validateFilePath(targetPath, "write");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    const content = await fs.readFile(targetPath, "utf8");
    if (!content.includes(oldText)) {
      return {
        success: false,
        error: "Old text not found in file.",
      };
    }
    await fs.writeFile(targetPath, content.replace(oldText, newText), "utf8");
    return {
      success: true,
      path: targetPath,
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
  const check = validateFilePath(targetPath, "write");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, content, "utf8");
    return {
      success: true,
      path: targetPath,
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
  const check = validateFilePath(targetPath, "delete");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await fs.unlink(targetPath);
    return {
      success: true,
      path: targetPath,
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
  try {
    await fs.access(targetPath);
    const stat = await fs.stat(targetPath);
    return {
      success: true,
      path: targetPath,
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
      path: targetPath,
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
  const check = validateFilePath(targetPath, "read");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const items: FileEntry[] = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      path: path.join(targetPath, entry.name),
    }));
    return {
      success: true,
      path: targetPath,
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
  const check = validateFilePath(targetPath, "delete");
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  try {
    await fs.rm(targetPath, { recursive: true, force: true });
    return {
      success: true,
      path: targetPath,
      message: "Directory deleted.",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
