/**
 * Decides whether release-check's exact `npm pack --dry-run` is skipped: local
 * dist hotspots (huge renderer asset trees) make the dry run pathologically
 * slow, so it is skipped when they exist unless ELIZA_FORCE_PACK_DRY_RUN=1.
 */
import { existsSync } from "node:fs";

const localPackHotspotPaths = [
  "dist",
  "dist/node_modules",
  "apps/app/dist",
  "apps/app/dist/vrms",
  "apps/app/dist/animations",
  "packages/app/dist",
  "packages/app/dist/vrms",
  "packages/app/dist/animations",
];

export function findLocalPackHotspots(
  candidates = localPackHotspotPaths,
  pathExists: (candidate: string) => boolean = existsSync,
): string[] {
  return candidates.filter((candidate) => pathExists(candidate));
}

export function shouldSkipExactPackDryRun(
  hotspots: string[],
  env = process.env,
): boolean {
  if (hotspots.length === 0) {
    return false;
  }

  if (env.ELIZA_FORCE_PACK_DRY_RUN === "1") {
    return false;
  }

  return true;
}
