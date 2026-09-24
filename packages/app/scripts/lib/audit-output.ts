/**
 * Resolves aesthetic-audit artifact directories while protecting repository and
 * filesystem roots from the runner's intentional recursive cleanup.
 */
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
  const insideRepository = containsPath(repoRoot, outputDir);
  const insideApp = containsPath(appDir, outputDir);
  const resultsRoot = path.join(repoRoot, "test-results");
  const insideResults =
    outputDir !== resultsRoot && containsPath(resultsRoot, outputDir);
  if (
    outputDir === path.parse(outputDir).root ||
    containsPath(outputDir, repoRoot) ||
    containsPath(outputDir, appDir) ||
    outputDir === resultsRoot ||
    (insideRepository && !insideApp && !insideResults)
  ) {
    throw new Error(
      `[ui-smoke] refusing to clean unsafe audit output: ${outputDir}`,
    );
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
