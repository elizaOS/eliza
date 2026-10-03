/**
 * Resolves aesthetic-audit artifact directories while protecting repository and
 * filesystem roots from the runner's intentional recursive cleanup.
 */
import fs from "node:fs";
import path from "node:path";

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function resolveAuditOutput({
  appDir,
  repoRoot,
  configured,
  defaultDirectory,
}) {
  const outputDir = path.resolve(
    appDir,
    configured?.trim() || path.join(repoRoot, "test-results", defaultDirectory),
  );
  // Check both the requested path and its existing ancestors. A temporary
  // output alias must not turn recursive cleanup into deletion of source.
  const canonicalize = (target) => {
    try {
      return fs.realpathSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(target);
      if (parent === target) throw error;
      return path.join(canonicalize(parent), path.basename(target));
    }
  };
  for (const resolve of [(value) => path.resolve(value), canonicalize]) {
    const output = resolve(outputDir);
    const repository = resolve(repoRoot);
    const app = resolve(appDir);
    const results = path.join(repository, "test-results");
    if (
      output === path.parse(output).root ||
      containsPath(output, repository) ||
      containsPath(output, app) ||
      output === results ||
      (containsPath(repository, output) && !containsPath(results, output))
    ) {
      throw new Error(
        `[ui-smoke] refusing to clean unsafe audit output: ${outputDir}`,
      );
    }
  }
  return outputDir;
}

export function resolveAuditAppOutput(options) {
  return resolveAuditOutput({
    ...options,
    defaultDirectory: "aesthetic-audit",
  });
}

export function resolveAuditCloudOutput(options) {
  return resolveAuditOutput({
    ...options,
    defaultDirectory: "aesthetic-audit-cloud",
  });
}
