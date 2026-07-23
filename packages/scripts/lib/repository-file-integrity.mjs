/**
 * Validates repository-owned source identities before automation reads or executes them.
 *
 * Git emits forward-slash paths on every platform. Rejecting alternate separators,
 * traversal, symlinks, and non-files keeps an inventory entry bound to the exact
 * checked-out bytes named in its report.
 */

import { lstatSync } from "node:fs";
import path from "node:path";

/** Validate and return one canonical repository-relative Git path. */
export function normalizeGitRepositoryPath(value, label = "repository path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty Git path`);
  }
  if (value.includes("\\")) {
    throw new Error(
      `${label} contains a backslash; Git inventory paths must use forward slashes`,
    );
  }
  if (path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be repository-relative`);
  }
  const segments = value.split("/");
  if (
    segments.includes("") ||
    segments.includes(".") ||
    segments.includes("..")
  ) {
    throw new Error(`${label} contains an empty or traversal segment`);
  }
  return value;
}

/** Reject duplicate and case/Unicode-colliding canonical repository identities. */
export function assertUniqueRepositoryIdentities(values, label) {
  const seen = new Map();
  for (const value of values) {
    const identity = value.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = seen.get(identity);
    if (previous !== undefined) {
      throw new Error(`${label}: ${previous} and ${value}`);
    }
    seen.set(identity, value);
  }
}

/**
 * Resolve a repository-relative path and require every descendant component to
 * be non-symlinked, with a regular file at the final identity.
 */
export function assertContainedRegularFile(repoRoot, relativePath, label) {
  const relative = normalizeGitRepositoryPath(relativePath, label);
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, ...relative.split("/"));
  const containment = path.relative(root, absolute);
  if (
    containment === "" ||
    containment.startsWith("..") ||
    path.isAbsolute(containment)
  ) {
    throw new Error(`${label} escapes the repository`);
  }

  let current = root;
  const segments = relative.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} may not traverse a symlink: ${relative}`);
    }
    const final = index === segments.length - 1;
    if (final ? !metadata.isFile() : !metadata.isDirectory()) {
      throw new Error(
        `${label} must resolve through directories to a regular file: ${relative}`,
      );
    }
  }
  return { absolute, relative };
}
