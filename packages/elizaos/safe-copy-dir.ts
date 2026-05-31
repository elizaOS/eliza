import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_SKIP_ENTRIES = new Set([
  ".DS_Store",
  ".git",
  ".turbo",
  ".vite",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function assertCopyPathContained(root: string, target: string, label: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Refusing ${label} outside copy root: ${target}`);
  }
}

/**
 * Recursively copy a directory tree without following symbolic links.
 * GHSA-jjf4-pjvf-h5jr: fs.copyFileSync follows symlinks; lstat rejects them first.
 */
export function copyDir(
  src: string,
  dest: string,
  skipEntries: ReadonlySet<string> = DEFAULT_SKIP_ENTRIES,
): void {
  const resolvedSrc = path.resolve(src);
  const resolvedDest = path.resolve(dest);
  assertCopyPathContained(resolvedSrc, resolvedSrc, "source");
  assertCopyPathContained(resolvedDest, resolvedDest, "destination");

  fs.mkdirSync(resolvedDest, { recursive: true });

  for (const entry of fs.readdirSync(resolvedSrc, { withFileTypes: true })) {
    if (skipEntries.has(entry.name)) continue;

    const srcPath = path.join(resolvedSrc, entry.name);
    const destPath = path.join(resolvedDest, entry.name);
    assertCopyPathContained(resolvedSrc, srcPath, "source entry");
    assertCopyPathContained(resolvedDest, destPath, "destination entry");

    const stat = fs.lstatSync(srcPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to copy symbolic link: ${srcPath}`);
    }
    if (stat.isDirectory()) {
      copyDir(srcPath, destPath, skipEntries);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing to copy non-regular file: ${srcPath}`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
}
