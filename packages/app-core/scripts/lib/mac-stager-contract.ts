/**
 * macOS artifact-stager staple-failure invariant (#17680).
 *
 * Carved out of the retired release-check monolith so the gate lives on after
 * its dead owner graph was removed. The contract is the contiguous block the
 * stager script (`platforms/electrobun/scripts/stage-macos-release-artifacts.sh`)
 * must keep when a notarized release REQUIRES a stapled DMG: the require-staple
 * branch must `exit 1` rather than fall through to the warning.
 */

/**
 * Whether `lines` appear in `content` as CONSECUTIVE lines, in order.
 *
 * `content.includes(line)` per line proves only that each line exists somewhere
 * in the file, in any order, at any distance. That is worthless when a line's
 * whole meaning is positional: `exit 1` occurs nine times in the macOS stager
 * and `fi` fifty-eight, so deleting the one `exit 1` that fails a
 * require-staple release still satisfies a per-line check (#17680).
 *
 * Indentation is compared after trimming so the guard survives reformatting,
 * but order and adjacency — the properties that carry the meaning — are pinned.
 */
export function containsContiguousBlock(
  content: string,
  lines: readonly string[],
): boolean {
  if (lines.length === 0) return true;
  const haystack = content.split("\n").map((line) => line.trim());
  const needle = lines.map((line) => line.trim());
  const last = haystack.length - needle.length;
  for (let start = 0; start <= last; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The staple-failure block of the macOS stager, asserted as one unit.
 *
 * Every line here is individually ambiguous or individually meaningless; the
 * contract lives in their arrangement. Keep this in sync with
 * `platforms/electrobun/scripts/stage-macos-release-artifacts.sh`.
 */
export const requiredMacStaplerFailureBlock = [
  'if ! retry_command "$STAPLER_ATTEMPTS" "$STAPLER_DELAY_SECONDS" xcrun stapler staple "$TEMP_DMG_PATH"; then',
  'if [[ "${ELECTROBUN_REQUIRE_STAPLED_DMG:-0}" == "1" ]]; then',
  "exit 1",
  "fi",
  'echo "stage-macos-release-artifacts: notarization accepted but stapler ticket was not available; continuing without stapled DMG" >&2',
  "fi",
] as const;
