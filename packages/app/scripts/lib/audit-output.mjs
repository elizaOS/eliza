/**
 * Resolves the app-audit artifact directory while protecting repository and
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

export function resolveAuditAppOutput({ appDir, repoRoot, configured }) {
  const outputDir = path.resolve(
    appDir,
    configured?.trim() || "aesthetic-audit-output",
  );
  const insideRepository = containsPath(repoRoot, outputDir);
  const insideApp = containsPath(appDir, outputDir);
  if (
    outputDir === path.parse(outputDir).root ||
    containsPath(outputDir, repoRoot) ||
    containsPath(outputDir, appDir) ||
    (insideRepository && !insideApp)
  ) {
    throw new Error(
      `[ui-smoke] refusing to clean unsafe audit output: ${outputDir}`,
    );
  }
  return outputDir;
}
