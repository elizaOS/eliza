import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function looksLikeElizaSubrepoRoot(dir) {
  return (
    existsSync(path.join(dir, "package.json")) &&
    existsSync(path.join(dir, "apps", "app", "package.json")) &&
    existsSync(
      path.join(dir, "eliza", "packages", "app-core", "package.json"),
    )
  );
}

function looksLikeFlatMonorepoRoot(dir) {
  const flat =
    existsSync(path.join(dir, "package.json")) &&
    existsSync(path.join(dir, "packages", "app-core", "package.json")) &&
    existsSync(path.join(dir, "packages", "agent", "package.json"));
  if (!flat) return false;
  // When the elizaOS workspace is bundled as the `eliza/` subrepo of a
  // consumer like Milady, the inner `eliza/` directory itself satisfies the
  // flat-monorepo shape. Resolving repoRoot to the inner directory would
  // then cause `scripts/<name>` step paths in run-repo-setup.mjs to look
  // under `eliza/scripts/…` instead of the consumer's own `scripts/…`.
  // Prefer the outer subrepo container in that case.
  if (path.basename(dir) === "eliza") {
    const parent = path.dirname(dir);
    if (parent !== dir && looksLikeElizaSubrepoRoot(parent)) {
      return false;
    }
  }
  return true;
}

function looksLikeRepoRoot(dir) {
  return looksLikeFlatMonorepoRoot(dir) || looksLikeElizaSubrepoRoot(dir);
}

export function resolveRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);

  while (true) {
    if (looksLikeRepoRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not resolve repository root starting from ${startDir}`,
      );
    }
    current = parent;
  }
}

export function resolveRepoRootFromImportMeta(importMetaUrl) {
  return resolveRepoRoot(path.dirname(fileURLToPath(importMetaUrl)));
}
