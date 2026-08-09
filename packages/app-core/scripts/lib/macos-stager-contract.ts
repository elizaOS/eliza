/**
 * Defines the fail-closed notarization block that the macOS artifact stager
 * must preserve. The contract compares trimmed lines in order because each
 * individual shell fragment is ambiguous elsewhere in the script.
 */

/** Ordered shell block that makes required stapling fail closed. */
export const requiredMacStaplerFailureBlock = [
  'if ! retry_command "$STAPLER_ATTEMPTS" "$STAPLER_DELAY_SECONDS" xcrun stapler staple "$TEMP_DMG_PATH"; then',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Shell parameter expansion is asserted verbatim.
  'if [[ "${ELECTROBUN_REQUIRE_STAPLED_DMG:-0}" == "1" ]]; then',
  "exit 1",
  "fi",
  'echo "stage-macos-release-artifacts: notarization accepted but stapler ticket was not available; continuing without stapled DMG" >&2',
  "fi",
] as const;

/** Whether trimmed lines occur consecutively and in order within content. */
export function containsContiguousBlock(
  content: string,
  lines: readonly string[],
): boolean {
  if (lines.length === 0) return true;

  const haystack = content.split("\n").map((line) => line.trim());
  const needle = lines.map((line) => line.trim());
  const lastStart = haystack.length - needle.length;

  for (let start = 0; start <= lastStart; start++) {
    if (needle.every((line, offset) => haystack[start + offset] === line)) {
      return true;
    }
  }

  return false;
}
