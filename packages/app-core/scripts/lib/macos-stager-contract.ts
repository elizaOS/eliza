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

/** Ordered shell block that derives the permission-host id from the bundle. */
export const requiredMacAppIdentifierReadBlock = [
  'APP_INFO_PLIST_PATH="$STAGED_APP_PATH/Contents/Info.plist"',
  'if ! APP_IDENTIFIER="$(/usr/bin/plutil -extract CFBundleIdentifier raw -expect string -o - "$APP_INFO_PLIST_PATH" 2>/dev/null)"; then',
  'echo "stage-macos-release-artifacts: failed to read CFBundleIdentifier from $APP_INFO_PLIST_PATH" >&2',
  "exit 1",
  "fi",
  'if [[ ! "$APP_IDENTIFIER" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then',
  'echo "stage-macos-release-artifacts: invalid CFBundleIdentifier: $APP_IDENTIFIER" >&2',
  "exit 1",
  "fi",
] as const;

/** Ordered shell block that assigns and verifies the permission-host identity. */
export const requiredMacPermissionHostIdentityBlock = [
  'bun_permission_host_path="$macos_code_dir/bun"',
  'if [[ ! -e "$bun_permission_host_path" ]]; then',
  'echo "stage-macos-release-artifacts: Bun permission host is missing: $bun_permission_host_path" >&2',
  "exit 1",
  "fi",
  'sign_macos_runtime_target_with_identifier "$bun_permission_host_path" "$APP_IDENTIFIER"',
  'codesign --verify --strict --verbose=2 -R "=identifier \\"$APP_IDENTIFIER\\"" "$bun_permission_host_path"',
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
