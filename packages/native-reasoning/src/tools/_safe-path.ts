import fs from "node:fs";
import path from "node:path";

/** Default workspace root if SHELL_ALLOWED_DIRECTORY is not set. */
export const DEFAULT_ALLOWED_DIR = "/workspace";

export function getAllowedDir(): string {
  const raw = process.env.SHELL_ALLOWED_DIRECTORY?.trim();
  const root = raw && raw.length > 0 ? raw : DEFAULT_ALLOWED_DIR;
  return path.resolve(root);
}

function assertContained(abs: string, allowed: string, original: string): void {
  const rel = path.relative(allowed, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `path '${original}' is outside the allowed directory '${allowed}'`,
    );
  }
}

function nearestExistingParent(abs: string): string {
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) {
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return dir;
}

/**
 * Resolve a (possibly relative) path against the allowed directory and
 * ensure the resolved absolute path is contained within it. Rejects any
 * input containing `..` segments before resolution as an extra guard.
 *
 * Throws on any escape attempt.
 */
export function resolveSafePath(
  p: string,
  allowedDir = getAllowedDir(),
): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  // Reject explicit traversal segments — even though path.resolve would
  // normalize them, we want a hard "don't even try" signal in the surface.
  const segments = p.split(/[\\/]/);
  if (segments.some((s) => s === "..")) {
    throw new Error(`path may not contain '..' segments: ${p}`);
  }

  const abs = path.isAbsolute(p)
    ? path.resolve(p)
    : path.resolve(allowedDir, p);
  const allowed = fs.realpathSync.native(path.resolve(allowedDir));

  // Lexical containment catches obvious escapes before filesystem checks.
  assertContained(abs, allowed, p);

  try {
    // Existing path: resolve symlinks all the way to the real target.
    const realTarget = fs.realpathSync.native(abs);
    assertContained(realTarget, allowed, p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;

    // New path: resolve the nearest existing parent so writes through a
    // symlinked directory cannot escape the allowed workspace.
    const realParent = fs.realpathSync.native(nearestExistingParent(abs));
    assertContained(realParent, allowed, p);
  }

  return abs;
}

export function truncate(
  s: string,
  max: number,
): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, max)}\n[...truncated ${s.length - max} bytes]`,
    truncated: true,
  };
}
