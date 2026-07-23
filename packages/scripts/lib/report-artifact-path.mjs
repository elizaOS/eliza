/**
 * Resolves generated test evidence only within the repository's reports tree.
 *
 * Producers may replace their exact output file, but they never traverse a
 * symlinked parent or accept an absolute/traversal path that could overwrite
 * source, configuration, or an external filesystem location.
 */

import { lstatSync } from "node:fs";
import path from "node:path";

function assertSafeParents(repoRoot, absolute, label) {
  let current = path.dirname(absolute);
  while (current !== repoRoot) {
    const relative = path.relative(repoRoot, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} escapes the repository reports directory`);
    }
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} has a symlinked parent: ${relative}`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(`${label} parent is not a directory: ${relative}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`${label} could not be contained within the repository`);
    }
    current = parent;
  }
}

/** Return canonical relative and absolute paths for one report artifact. */
export function resolveReportArtifactPath(
  repoRoot,
  value,
  { extension, label },
) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${label} requires a non-empty file path`);
  }
  const normalizedSlashes = value.split("\\").join("/");
  if (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(normalizedSlashes) ||
    /^[A-Za-z]:\//.test(normalizedSlashes)
  ) {
    throw new Error(`${label} must be repository-relative under reports/`);
  }
  const segments = normalizedSlashes.split("/");
  if (
    segments.includes("..") ||
    segments.includes(".") ||
    segments.includes("")
  ) {
    throw new Error(`${label} may not contain empty or traversal segments`);
  }
  const relative = path.posix.normalize(normalizedSlashes);
  if (!relative.startsWith("reports/")) {
    throw new Error(`${label} must be under reports/`);
  }
  if (
    path.posix.extname(relative) !== extension ||
    path.posix.basename(relative) === extension
  ) {
    throw new Error(`${label} must name a ${extension} file`);
  }
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, ...relative.split("/"));
  assertSafeParents(root, absolute, label);
  return { absolute, relative };
}
