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
 * Returns true when the release carries at least one downloadable asset — the
 * marketing page renders normal download cards. Returns false when no usable
 * downloads exist, regardless of tag name — this covers both
 * `buildRelease(null)` (`{ tagName: "unavailable", downloads: [] }`) and any
 * real-tagged release whose assets were stripped or are still pending. The
 * component must show a distinct unavailable state instead of active download
 * links in both cases.
 */
export function isReleaseAvailable(
  release: Pick<ReleaseDataRelease, "tagName" | "downloads">,
): boolean {
  return release.downloads.length > 0;
}
