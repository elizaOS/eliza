/**
 * Release selection for the homepage download surface.
 *
 * Generated release data may include an empty stable release while canary
 * carries the current assets. The UI treats that canary as the effective
 * release so every visible tag, release-note link, checksum link, and download
 * card points at the same GitHub release.
 */
import type {
  ReleaseDataPayload,
  ReleaseDataRelease,
} from "../generated/release-data";

export function selectEffectiveRelease(
  data: ReleaseDataPayload,
): ReleaseDataRelease {
  if (data.release.downloads.length > 0) return data.release;
  return data.canaryRelease ?? data.release;
}
