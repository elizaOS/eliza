/**
 * Filesystem helpers for SOC2 checks that inspect repository evidence paths.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export function fileExists(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function dirExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

export function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

export function readUtf8Safe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // error-policy:J3 designed optional read — the "Safe" variant's contract is
    // "content or null"; a check that needs a present file uses readUtf8 (which
    // throws). `null` here is "file absent/unreadable", an expected outcome
    // callers branch on. (The strict variant is `readUtf8` above.)
    return null;
  }
}

/** Recursive listing limited by depth & filename regex. Skips node_modules, .git, dist. */
export async function walk(
  root: string,
  opts: { match?: RegExp; maxDepth?: number; exclude?: RegExp } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 12;
  const exclude =
    opts.exclude ??
    /(^|\/)(node_modules|\.git|dist|build|\.next|\.turbo|coverage|\.cache)(\/|$)/;
  const out: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (exclude.test(dir)) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (exclude.test(p)) continue;
        await rec(p, depth + 1);
      } else if (e.isFile()) {
        if (!opts.match || opts.match.test(p)) out.push(p);
      }
    }
  }
  await rec(root, 0);
  return out;
}
