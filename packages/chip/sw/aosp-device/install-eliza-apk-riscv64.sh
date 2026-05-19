#!/usr/bin/env bash
# install-eliza-apk-riscv64.sh
#
# Install the riscv64 Eliza agent APK on a live Cuttlefish virtual device.
# Pairs with launch-cuttlefish-riscv64.sh (Task 29) and
# start-eliza-agent-riscv64.sh + agent-smoke-riscv64.sh (Task 30).
#
# Locates the APK from --apk, ELIZA_APK_PATH, or the workspace default of
# packages/app/android/app/build/outputs/apk/release/app-riscv64-release.apk
# under the current repo root. Refuses to install an APK with no
# lib/riscv64/*.so payload so the operator does not chase a downstream
# INSTALL_FAILED_NO_MATCHING_ABIS without a clear hint.
#
# This script is install-only. Foreground-service bring-up lives in
# start-eliza-agent-riscv64.sh; end-to-end smokes live in
# agent-smoke-riscv64.sh.

set -euo pipefail

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
workspace_root=$(CDPATH=; cd -- "$repo_root/../.." && pwd)
default_apk_rel="packages/app/android/app/build/outputs/apk/release/app-riscv64-release.apk"

usage() {
	cat >&2 <<'USAGE'
usage: install-eliza-apk-riscv64.sh [options]

Install the riscv64 Eliza agent APK on a live CVD via adb. Validates the
APK ships lib/riscv64/*.so jniLibs before invoking adb install -r -g.

options:
  --apk=PATH              path to the riscv64 APK (defaults to
                          ELIZA_APK_PATH then
                          packages/app/android/app/build/outputs/apk/release/
                          app-riscv64-release.apk under the workspace root)
  --serial=SERIAL         adb serial (forwarded as `adb -s SERIAL`); if
                          unset, the default device is used
  --package=NAME          expected Android package name to verify after
                          install (default: com.elizaos.agent)
  --help                  this message
USAGE
}

apk=${ELIZA_APK_PATH:-}
serial=${AOSP_ADB_SERIAL:-}
package=${AOSP_AGENT_PACKAGE:-com.elizaos.agent}

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

# riscv64 jniLibs guard.
if ! unzip -l "$apk" 2>/dev/null | grep -q "lib/riscv64/"; then
	echo "error: $apk has no lib/riscv64/*.so payload" >&2
	echo "       check jniLibs/riscv64/ staging in the APK build (packages/app/android)" >&2
	exit 1
fi
log "lib/riscv64/ payload: present"

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
