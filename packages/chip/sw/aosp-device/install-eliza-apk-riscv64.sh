#!/usr/bin/env bash
# install-eliza-apk-riscv64.sh
#
# Install the riscv64 Eliza agent APK on a live Cuttlefish virtual device.
# Pairs with launch-cuttlefish-riscv64.sh (Task 29) and
# start-eliza-agent-riscv64.sh + agent-smoke-riscv64.sh (Task 30).
#
# Locates the APK from --apk, ELIZA_APK_PATH, or the workspace default of
# packages/app-core/platforms/android/app/build/outputs/apk/release/app-riscv64-release.apk
# under the current repo root. Refuses to install an APK without the complete
# riscv64 local-agent payload so the operator does not chase downstream ABI,
# extraction, or service-health failures without a clear hint.
#
# This script is install-only. Foreground-service bring-up lives in
# start-eliza-agent-riscv64.sh; end-to-end smokes live in
# agent-smoke-riscv64.sh.

set -euo pipefail

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
workspace_root=$(CDPATH=; cd -- "$repo_root/../.." && pwd)
default_apk_rel="packages/app-core/platforms/android/app/build/outputs/apk/release/app-riscv64-release.apk"

usage() {
	cat >&2 <<'USAGE'
usage: install-eliza-apk-riscv64.sh [options]

Install the riscv64 Eliza agent APK on a live CVD via adb. Validates the
APK ships the complete assets/agent/riscv64 and lib/riscv64 local-agent
payload before invoking adb install -r -g.

options:
  --apk=PATH              path to the riscv64 APK (defaults to
                          ELIZA_APK_PATH then
                          packages/app-core/platforms/android/app/build/outputs/apk/release/
                          app-riscv64-release.apk under the workspace root)
  --serial=SERIAL         adb serial (forwarded as `adb -s SERIAL`); if
                          unset, the default device is used
  --package=NAME          expected Android package name to verify after
                          install (default: ai.elizaos.app)
  --help                  this message
USAGE
}

apk=${ELIZA_APK_PATH:-}
serial=${AOSP_ADB_SERIAL:-}
package=${AOSP_AGENT_PACKAGE:-ai.elizaos.app}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--apk=*) apk=${1#*=}; shift ;;
		--serial=*) serial=${1#*=}; shift ;;
		--package=*) package=${1#*=}; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
	esac
done

if [ -z "$apk" ]; then
	apk="$workspace_root/$default_apk_rel"
fi

if [ ! -f "$apk" ]; then
	echo "error: APK not found: $apk" >&2
	echo "       set ELIZA_APK_PATH or pass --apk=/abs/path/to/eliza-agent-riscv64.apk" >&2
	exit 1
fi

log() { printf 'install-eliza-apk %s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf 'install-eliza-apk error: %s\n' "$*" >&2; exit 1; }

if ! command -v adb >/dev/null 2>&1; then
	fail "adb not on PATH; source build/envsetup.sh from the AOSP tree first"
fi
if ! command -v unzip >/dev/null 2>&1; then
	fail "unzip not on PATH; install zip/unzip on the host"
fi

adb_cmd() {
	if [ -n "$serial" ]; then
		adb -s "$serial" "$@"
	else
		adb "$@"
	fi
}

log "apk=$apk"
log "package=$package"
[ -n "$serial" ] && log "serial=$serial"

# riscv64 local-agent runtime guard. Keep this list in sync with
# check_android_system_apk_payload.py and check_android_app_runtime_contract.py.
required_entries="
assets/agent/riscv64/bun
assets/agent/riscv64/ld-musl-riscv64.so.1
assets/agent/riscv64/libstdc++.so.6.0.33
assets/agent/riscv64/libgcc_s.so.1
lib/riscv64/libeliza_bun.so
lib/riscv64/libeliza_gcc_s.so
lib/riscv64/libeliza_ld_musl_riscv64.so
lib/riscv64/libeliza_stdcpp.so
assets/agent/android-agent-runtime-provenance.json
META-INF/eliza/aosp-build-provenance.json
"
apk_entries=$(unzip -Z1 "$apk" 2>/dev/null || true)
missing_entries=""
for entry in $required_entries; do
	if ! printf '%s\n' "$apk_entries" | grep -qx "$entry"; then
		missing_entries="${missing_entries}
  - ${entry}"
	fi
done
if [ -n "$missing_entries" ]; then
	echo "error: $apk is missing required riscv64 local-agent payload entries:" >&2
	printf '%s\n' "$missing_entries" >&2
	echo "       build/stage the APK with a verified bun-linux-riscv64-musl.zip:" >&2
	echo "       ELIZA_BUN_RISCV64_FILE=/path/to/bun-linux-riscv64-musl.zip \\" >&2
	echo "       ELIZA_BUN_RISCV64_SHA256=<sha256> ELIZA_BUN_RISCV64_REQUIRED=1 \\" >&2
	echo "       bun run --cwd packages/app-core build:android:system" >&2
	exit 1
fi
log "riscv64 local-agent payload: complete"

# Device ABI snapshot for triage. Not a hard guard; the install will fail
# fast with INSTALL_FAILED_NO_MATCHING_ABIS if the device is not riscv64.
abilist=$(adb_cmd shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r')
log "ro.product.cpu.abilist=$abilist"

# adb install -r -g auto-grants runtime permissions.
log "adb install -r -g $apk"
install_log=$(mktemp "${TMPDIR:-/tmp}/install-eliza-apk-riscv64.XXXXXX")
trap 'rm -f "$install_log"' EXIT
if ! adb_cmd install -r -g "$apk" >"$install_log" 2>&1; then
	rc=$?
	cat "$install_log" >&2
	if grep -q INSTALL_FAILED_NO_MATCHING_ABIS "$install_log"; then
		echo "error: device ABI does not accept the APK" >&2
		echo "       ro.product.cpu.abilist=$abilist" >&2
		echo "       APK native libs:" >&2
		unzip -l "$apk" | awk '/lib\//{print "         " $0}' >&2
	fi
	exit "$rc"
fi
cat "$install_log"

# Verify the package landed.
listing=$(adb_cmd shell pm list packages "$package" 2>/dev/null | tr -d '\r')
if ! printf '%s\n' "$listing" | grep -qx "package:$package"; then
	fail "package $package not found after install (pm list: $listing)"
fi
log "verified: pm list packages contains $package"
