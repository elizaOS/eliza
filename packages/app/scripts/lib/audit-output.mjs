/**
 * Resolves the app-audit artifact directory while protecting repository and
 * filesystem roots from the runner's intentional recursive cleanup.
 */
import path from "node:path";

export function resolveAuditAppOutput({ appDir, repoRoot, configured }) {
  const outputDir = path.resolve(
    appDir,
    configured?.trim() || "aesthetic-audit-output",
  );
  const forbidden = new Set([path.parse(outputDir).root, repoRoot, appDir]);
  if (forbidden.has(outputDir)) {
    throw new Error(
      `[ui-smoke] refusing to clean unsafe audit output: ${outputDir}`,
    );
  }
  return outputDir;
}
