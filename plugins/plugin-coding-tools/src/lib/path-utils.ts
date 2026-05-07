import * as fs from "node:fs/promises";
import * as path from "node:path";

const BLOCKED_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);

const BLOCKED_PROC_FD = /^\/proc\/\d+\/fd\//;

export function isAbsolutePath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (p.startsWith("\\\\") || p.startsWith("//")) return false;
  return path.isAbsolute(p);
}

export function isBlockedPath(p: string): boolean {
  if (BLOCKED_PATHS.has(p)) return true;
  if (BLOCKED_PROC_FD.test(p)) return true;
  return false;
}

export function normalizeAbsolute(p: string): string {
  return path.resolve(p);
}

export async function resolveRealPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export function isWithin(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function isWithinAnyRoot(p: string, roots: string[]): Promise<boolean> {
  if (roots.length === 0) return false;
  const real = await resolveRealPath(p);
  for (const root of roots) {
    const rootReal = await resolveRealPath(root);
    if (isWithin(real, rootReal)) return true;
  }
  return false;
}

export function isUncPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

export function relativeFromRoot(p: string, root: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" ? "." : rel;
}
