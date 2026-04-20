#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACTS_DIR="${1:-apps/app/electrobun/artifacts}"
SKIP_SIGNATURE_CHECK="${ELECTROBUN_SKIP_CODESIGN:-0}"
REAL_XCRUN="${ELECTROBUN_REAL_XCRUN:-/usr/bin/xcrun}"
NOTARY_POLL_ATTEMPTS="${ELECTROBUN_NOTARY_POLL_ATTEMPTS:-45}"
NOTARY_POLL_DELAY_SECONDS="${ELECTROBUN_NOTARY_POLL_DELAY_SECONDS:-20}"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "stage-macos-release-artifacts: macOS only"
  exit 1
fi

if [[ ! -d "$ARTIFACTS_DIR" ]]; then
  echo "stage-macos-release-artifacts: artifacts directory not found: $ARTIFACTS_DIR"
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/milady-macos-artifacts.XXXXXX")"
EXTRACT_DIR="$TMP_ROOT/extracted"
DMG_STAGING_DIR="$TMP_ROOT/dmg-staging"
TEMP_DMG_PATH=""

cleanup() {
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}

trap cleanup EXIT

mkdir -p "$EXTRACT_DIR" "$DMG_STAGING_DIR"

retry_command() {
  local attempts="$1"
  local delay_seconds="$2"
  shift 2

  local attempt command_status=0
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if "$@"; then
      return 0
    else
      command_status=$?
    fi
    echo "Command failed (attempt $attempt/$attempts, exit=$command_status): $*" >&2
    if [[ "$attempt" -lt "$attempts" ]]; then
      sleep "$((delay_seconds * attempt))"
    fi
  done

  return "$command_status"
}

parse_notary_submission_id() {
  local output_path="$1"
  /usr/bin/python3 - "$output_path" <<'PY'
import json
import pathlib
import sys

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")

try:
    payload = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(1)

for key in ("id", "submissionId", "uuid", "notarizationId"):
    value = payload.get(key)
    if value:
        print(value)
        break
PY
}

parse_notary_status() {
  local output_path="$1"
  /usr/bin/python3 - "$output_path" <<'PY'
import json
import pathlib
import sys

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")

try:
    payload = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(1)

status = payload.get("status") or payload.get("message") or ""
if status:
    print(status)
PY
}

wait_for_notary_acceptance() {
  local submission_id="$1"
  local attempt status_output_path status_text normalized_status

  for ((attempt = 1; attempt <= NOTARY_POLL_ATTEMPTS; attempt += 1)); do
    status_output_path="$TMP_ROOT/notary-info-$attempt.json"

    if "$REAL_XCRUN" notarytool info \
      --apple-id "$ELECTROBUN_APPLEID" \
      --password "$ELECTROBUN_APPLEIDPASS" \
      --team-id "$ELECTROBUN_TEAMID" \
      --output-format json \
      "$submission_id" >"$status_output_path" 2>&1; then
      status_text="$(parse_notary_status "$status_output_path" || true)"
      if [[ -z "$status_text" ]]; then
        echo "Notary status ($attempt/$NOTARY_POLL_ATTEMPTS): unknown"
        sed -n '1,40p' "$status_output_path" >&2 || true
      else
        echo "Notary status ($attempt/$NOTARY_POLL_ATTEMPTS): $status_text"
      fi

      normalized_status="$(printf '%s' "$status_text" | tr '[:upper:]' '[:lower:]')"
      case "$normalized_status" in
        accepted)
          return 0
          ;;
        invalid|rejected)
          echo "stage-macos-release-artifacts: notarization failed for submission $submission_id" >&2
          "$REAL_XCRUN" notarytool log \
            --apple-id "$ELECTROBUN_APPLEID" \
            --password "$ELECTROBUN_APPLEIDPASS" \
            --team-id "$ELECTROBUN_TEAMID" \
            "$submission_id" || true
          return 1
          ;;
      esac
    else
      echo "stage-macos-release-artifacts: notary status request failed (attempt $attempt/$NOTARY_POLL_ATTEMPTS); retrying..." >&2
      sed -n '1,40p' "$status_output_path" >&2 || true
    fi

    if [[ "$attempt" -lt "$NOTARY_POLL_ATTEMPTS" ]]; then
      sleep "$NOTARY_POLL_DELAY_SECONDS"
    fi
  done

  echo "stage-macos-release-artifacts: timed out waiting for notarization approval for submission $submission_id" >&2
  return 1
}

TARBALL_PATH="$(find -L "$ARTIFACTS_DIR" -maxdepth 1 -type f -name "*-macos-*.app.tar.zst" | sort | head -1)"
if [[ -z "$TARBALL_PATH" ]]; then
  echo "stage-macos-release-artifacts: no macOS updater tarball found in $ARTIFACTS_DIR"
  exit 1
fi

echo "Using updater tarball: $TARBALL_PATH"
tar --zstd -xf "$TARBALL_PATH" -C "$EXTRACT_DIR"

APP_BUNDLE_PATH="$(find "$EXTRACT_DIR" -maxdepth 2 -type d -name "*.app" | sort | head -1)"
if [[ -z "$APP_BUNDLE_PATH" ]]; then
  echo "stage-macos-release-artifacts: extracted tarball did not contain a .app bundle"
  exit 1
fi

STAGED_APP_PATH="$ARTIFACTS_DIR/$(basename "$APP_BUNDLE_PATH")"
rm -rf "$STAGED_APP_PATH"
ditto "$APP_BUNDLE_PATH" "$STAGED_APP_PATH"

LAUNCHER_PATH="$STAGED_APP_PATH/Contents/MacOS/launcher"
WGPU_PATH="$STAGED_APP_PATH/Contents/MacOS/libwebgpu_dawn.dylib"
VERSION_JSON_PATH="$STAGED_APP_PATH/Contents/Resources/version.json"
RUNTIME_DIR="$STAGED_APP_PATH/Contents/Resources/app/eliza-dist"
DIRECT_LAUNCHER_SOURCE="$SCRIPT_DIR/macos-direct-launcher.c"

for required_path in "$LAUNCHER_PATH" "$WGPU_PATH" "$VERSION_JSON_PATH" "$RUNTIME_DIR"; do
  if [[ ! -e "$required_path" ]]; then
    echo "stage-macos-release-artifacts: expected extracted app content is missing: $required_path"
    exit 1
  fi
done

if [[ ! -f "$DIRECT_LAUNCHER_SOURCE" ]]; then
  echo "stage-macos-release-artifacts: direct launcher source not found: $DIRECT_LAUNCHER_SOURCE"
  exit 1
fi

entitlement_args=()
if [[ "$SKIP_SIGNATURE_CHECK" != "1" && -n "${ELECTROBUN_DEVELOPER_ID:-}" ]]; then
  TMP_ENTITLEMENTS_PATH="$TMP_ROOT/staged-entitlements.plist"
  if ! codesign -d --entitlements :- "$STAGED_APP_PATH" >"$TMP_ENTITLEMENTS_PATH" 2>/dev/null; then
    echo "stage-macos-release-artifacts: failed to extract entitlements from staged app bundle"
    exit 1
  fi
  if [[ ! -s "$TMP_ENTITLEMENTS_PATH" ]]; then
    echo "stage-macos-release-artifacts: extracted entitlements were empty"
    exit 1
  fi
  entitlement_args=(--entitlements "$TMP_ENTITLEMENTS_PATH")
fi

TMP_LAUNCHER_PATH="$TMP_ROOT/direct-launcher"
LAUNCHER_ARCHES="$(lipo -archs "$LAUNCHER_PATH" 2>/dev/null || true)"
if [[ -z "$LAUNCHER_ARCHES" ]]; then
  echo "stage-macos-release-artifacts: failed to determine launcher architecture for $LAUNCHER_PATH"
  exit 1
fi

clang_arch_args=()
for arch in $LAUNCHER_ARCHES; do
  case "$arch" in
    arm64|x86_64)
      clang_arch_args+=(-arch "$arch")
      ;;
    *)
      echo "stage-macos-release-artifacts: unsupported launcher architecture: $arch"
      exit 1
      ;;
  esac
done

/usr/bin/clang \
  -O2 \
  -Wall \
  -Wextra \
  "${clang_arch_args[@]}" \
  -mmacosx-version-min=11.0 \
  "$DIRECT_LAUNCHER_SOURCE" \
  -o "$TMP_LAUNCHER_PATH"
install -m 0755 "$TMP_LAUNCHER_PATH" "$LAUNCHER_PATH"

echo "Staged app bundle: $STAGED_APP_PATH"
if [[ "$SKIP_SIGNATURE_CHECK" != "1" && -n "${ELECTROBUN_DEVELOPER_ID:-}" ]]; then
  # The extracted updater app bundle is already correctly signed/notarized by
  # electrobun. Re-sign only what changed and keep the original entitlements so
  # we do not rewrite valid nested signatures with a blanket --deep pass.
  if ! codesign --force --timestamp --sign "$ELECTROBUN_DEVELOPER_ID" --options runtime "${entitlement_args[@]}" "$LAUNCHER_PATH"; then
    echo "stage-macos-release-artifacts: launcher runtime signing failed, retrying without hardened runtime" >&2
    codesign --force --timestamp --sign "$ELECTROBUN_DEVELOPER_ID" "${entitlement_args[@]}" "$LAUNCHER_PATH"
  fi
  codesign --force --timestamp --sign "$ELECTROBUN_DEVELOPER_ID" --options runtime "${entitlement_args[@]}" "$STAGED_APP_PATH"
  codesign --verify --deep --strict --verbose=2 "$STAGED_APP_PATH"
else
  echo "Skipping staged app signature verification (unsigned/local build)."
fi

FINAL_DMG_NAME="$(basename "${TARBALL_PATH%.app.tar.zst}.dmg")"
FINAL_DMG_PATH="$ARTIFACTS_DIR/$FINAL_DMG_NAME"
TEMP_DMG_PATH="$TMP_ROOT/$FINAL_DMG_NAME"
VOLUME_NAME="$(basename "$STAGED_APP_PATH" .app)"

ditto "$STAGED_APP_PATH" "$DMG_STAGING_DIR/$(basename "$STAGED_APP_PATH")"
ln -s /Applications "$DMG_STAGING_DIR/Applications"

rm -f "$FINAL_DMG_PATH"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$DMG_STAGING_DIR" \
  -ov \
  -format ULFO \
  "$TEMP_DMG_PATH"

if [[ "$SKIP_SIGNATURE_CHECK" != "1" && -n "${ELECTROBUN_DEVELOPER_ID:-}" ]]; then
  codesign --force --timestamp --sign "$ELECTROBUN_DEVELOPER_ID" "$TEMP_DMG_PATH"
fi

if [[ "$SKIP_SIGNATURE_CHECK" != "1" && -n "${ELECTROBUN_APPLEID:-}" && -n "${ELECTROBUN_APPLEIDPASS:-}" && -n "${ELECTROBUN_TEAMID:-}" ]]; then
  NOTARY_SUBMIT_OUTPUT_PATH="$TMP_ROOT/notary-submit.json"
  "$REAL_XCRUN" notarytool submit \
    --apple-id "$ELECTROBUN_APPLEID" \
    --password "$ELECTROBUN_APPLEIDPASS" \
    --team-id "$ELECTROBUN_TEAMID" \
    --output-format json \
    "$TEMP_DMG_PATH" >"$NOTARY_SUBMIT_OUTPUT_PATH"
  NOTARY_SUBMISSION_ID="$(parse_notary_submission_id "$NOTARY_SUBMIT_OUTPUT_PATH" || true)"
  if [[ -z "$NOTARY_SUBMISSION_ID" ]]; then
    echo "stage-macos-release-artifacts: failed to parse notary submission id" >&2
    sed -n '1,40p' "$NOTARY_SUBMIT_OUTPUT_PATH" >&2 || true
    exit 1
  fi
  echo "Notary submission id: $NOTARY_SUBMISSION_ID"
  wait_for_notary_acceptance "$NOTARY_SUBMISSION_ID"
  # Apple can lag several minutes before the notarization ticket becomes
  # visible to stapler, especially on Intel runners.
  retry_command 8 20 xcrun stapler staple "$TEMP_DMG_PATH"
fi

mv "$TEMP_DMG_PATH" "$FINAL_DMG_PATH"

echo "Standard macOS installer ready:"
echo "  app: $STAGED_APP_PATH"
echo "  dmg: $FINAL_DMG_PATH"
