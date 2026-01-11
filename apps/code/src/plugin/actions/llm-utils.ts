import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCwd } from "../providers/cwd.js";

export function extractFilePathFromText(text: string): string {
  const patterns = [
    /(?:explain|review|refactor|fix|test|tests?|analyze)\s+["']?([^\s"']+\.[a-z0-9]{1,10})["']?/i,
    /(?:file|in)\s+["']?([^\s"']+\.[a-z0-9]{1,10})["']?/i,
    /`([^`]+\.[a-z0-9]{1,10})`/i,
    /["']([^"']+\.[a-z0-9]{1,10})["']/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }

  const loose = text.match(/(?:\.\/|\/)?[\w\-./]+\.[a-z0-9]{1,10}\b/i);
  return loose?.[0] ?? "";
}

export type ReadFileForPromptResult =
  | { ok: true; filepath: string; content: string; extension: string }
  | { ok: false; error: string };

export async function readFileForPrompt(
  filepath: string,
): Promise<ReadFileForPromptResult> {
  if (!filepath) {
    return { ok: false, error: "No file path provided" };
  }
  const fullPath = path.resolve(getCwd(), filepath);
  try {
    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      return { ok: false, error: `${filepath} is a directory` };
    }
    const content = await fs.readFile(fullPath, "utf-8");
    const extension = path.extname(filepath).slice(1) || "txt";
    return { ok: true, filepath, content, extension };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT")
      return { ok: false, error: `File not found: ${filepath}` };
    if (error.code === "EACCES")
      return { ok: false, error: `Permission denied: ${filepath}` };
    return { ok: false, error: `Error reading file: ${error.message}` };
  }
}

export function toTrimmedText(result: string): string {
  return result.trim();
}
