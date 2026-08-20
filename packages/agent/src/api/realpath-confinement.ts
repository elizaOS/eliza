/**
 * Canonical path confinement shared by agent HTTP file-serving boundaries.
 *
 * Missing leaves resolve through their deepest existing ancestor. Benign
 * symlink prefixes are followed, while dangling links, loops, permission
 * faults, and other unresolvable paths return `null` so callers fail closed.
 */

import fs from "node:fs";
import path from "node:path";

function errnoCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

/** Resolve an existing path or a missing tail to its canonical spelling. */
export function resolveRealPathSync(inputPath: string): string | null {
  let current = path.resolve(inputPath);
  const tail: string[] = [];

  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch (error) {
      // error-policy:J3 only a genuinely missing component may walk upward;
      // an existing but unresolvable component is a dangling link or fault.
      if (errnoCode(error) !== "ENOENT") return null;
      try {
        fs.lstatSync(current);
        return null;
      } catch (probeError) {
        // error-policy:J3 untrusted paths fail closed unless lstat confirms
        // that this exact component is absent.
        if (errnoCode(probeError) !== "ENOENT") return null;
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Async counterpart to `resolveRealPathSync` for request handlers. */
export async function resolveRealPath(
  inputPath: string,
): Promise<string | null> {
  let current = path.resolve(inputPath);
  const tail: string[] = [];

  while (true) {
    try {
      return path.join(await fs.promises.realpath(current), ...tail);
    } catch (error) {
      // error-policy:J3 only a genuinely missing component may walk upward;
      // an existing but unresolvable component is a dangling link or fault.
      if (errnoCode(error) !== "ENOENT") return null;
      try {
        await fs.promises.lstat(current);
        return null;
      } catch (probeError) {
        // error-policy:J3 untrusted paths fail closed unless lstat confirms
        // that this exact component is absent.
        if (errnoCode(probeError) !== "ENOENT") return null;
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Test canonical containment, optionally accepting the root itself. */
export function isPathWithinRoot(
  candidate: string,
  root: string,
  options: { allowRoot?: boolean } = {},
): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  if (resolvedCandidate === resolvedRoot) return options.allowRoot === true;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
