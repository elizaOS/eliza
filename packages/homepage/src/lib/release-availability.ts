/**
 * Pure availability check for the homepage release/download surface.
 *
 * The marketing page must distinguish three states per the repo error-policy:
 * loading, a usable release with downloads, and an unavailable state where no
 * usable product release exists. This function owns that decision so the UI
 * branch and its test share one source of truth.
 */

import type { ReleaseDataRelease } from "@/generated/release-data";

/**
 * Returns true only for a non-sentinel release carrying the complete required
 * installer set. The generator and CI checker enforce the same five IDs; this
 * final UI-boundary check keeps a stale or contradictory generated payload
 * from exposing partial or misleading download cards.
 */
export function isReleaseAvailable(
  release: Pick<ReleaseDataRelease, "tagName" | "downloads">,
): boolean {
  if (release.tagName === "unavailable") return false;
  const ids = new Set(release.downloads.map((download) => download.id));
  return [
    "macos-arm64",
    "macos-x64",
    "windows-x64",
    "linux-x64",
    "android-apk",
  ].every((id) => ids.has(id));
}
