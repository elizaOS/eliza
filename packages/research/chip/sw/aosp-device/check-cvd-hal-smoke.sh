#!/usr/bin/env sh
# check-cvd-hal-smoke.sh
#
# Boot a Cuttlefish riscv64 instance, query lshal, and assert the
# vendor.eliza.e1_npu@1.0::IE1Npu/default service is registered and
# reported INTERFACE_AVAILABLE. Captures the transcript to
# docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log with provenance,
# pass/fail status, and HAL_REGISTERED=true marker.
#
# Operator entry point. Requires:
#   * AOSP source tree at $1 with Cuttlefish host artifacts built
#     (Task 28 produces them).
#   * Cuttlefish host stack (cvd or launch_cvd) on PATH.
#   * adb on PATH.
#
# Does not build anything itself. Will refuse to fabricate evidence if
# the cvd_runtime / adb / lshal calls fail.

set -eu

usage() {
	echo "usage: $0 /path/to/aosp" >&2
	echo "  AOSP_PRODUCT=aosp_cf_riscv64_phone-trunk_staging-userdebug" >&2
	echo "  AOSP_CUTTLEFISH_ARGS='--cpus=4 --memory_mb=8192 --gpu_mode=none'" >&2
	echo "  AOSP_ADB_TIMEOUT_SECONDS=180" >&2
}

if [ "$#" -ne 1 ]; then
	usage
	exit 2
fi

aosp=$1
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)
evidence_dir="$repo_root/docs/evidence/android"
out_log="$evidence_dir/eliza_ai_soc_cvd_hal_smoke.log"
aosp_shell=${AOSP_SHELL:-bash}
aosp_product=${AOSP_PRODUCT:-aosp_cf_riscv64_phone-trunk_staging-userdebug}
aosp_cuttlefish_args=${AOSP_CUTTLEFISH_ARGS:---cpus=4 --memory_mb=8192 --gpu_mode=none}
aosp_cuttlefish_launcher=${AOSP_CUTTLEFISH_LAUNCHER:-}
aosp_adb_timeout_seconds=${AOSP_ADB_TIMEOUT_SECONDS:-180}
aosp_adb_serial=${AOSP_ADB_SERIAL:-}
expected_hal_name=vendor.eliza.e1_npu@1.0::IE1Npu/default

if [ ! -f "$aosp/build/envsetup.sh" ] || [ ! -d "$aosp/device" ]; then
	echo "error: $aosp does not look like an AOSP checkout" >&2
	exit 1
fi
if ! command -v "$aosp_shell" >/dev/null 2>&1; then
	echo "error: AOSP shell '$aosp_shell' is not available; set AOSP_SHELL=/path/to/bash" >&2
	exit 1
fi

mkdir -p "$evidence_dir"

start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
status_file=$(mktemp "${TMPDIR:-/tmp}/check-cvd-hal-smoke.XXXXXX")
status=FAIL
hal_registered=false
interface_available=false

{
	echo "eliza-evidence: target=aosp artifact=eliza_ai_soc_cvd_hal_smoke"
	echo "eliza-evidence: external_tree=$aosp"
	echo "eliza-evidence: command=launch_cvd && adb shell lshal -i | grep vendor.eliza.e1_npu"
	echo "eliza-evidence: claim_boundary=virtual_device_smoke_only_not_boot_or_compatibility_evidence"
	echo "EXTERNAL_TREE=$aosp"
	echo "COMMAND=launch_cvd && adb shell lshal -i | grep vendor.eliza.e1_npu"
	echo "START_UTC=$start_utc"
	echo "COMPATIBILITY_CLAIM=none"
	echo "BOOT_CLAIM=none"
	echo "SCHEMA=docs/android/boot-transcript.schema.json"
	echo "EXPECTED_HAL=$expected_hal_name"
	echo "eliza-evidence: started_utc=$start_utc"

	cd "$aosp"
	set +e
		# shellcheck disable=SC2016
		env AOSP_PRODUCT="$aosp_product" \
		AOSP_CUTTLEFISH_ARGS="$aosp_cuttlefish_args" \
		AOSP_CUTTLEFISH_LAUNCHER="$aosp_cuttlefish_launcher" \
		AOSP_ADB_TIMEOUT_SECONDS="$aosp_adb_timeout_seconds" \
		AOSP_ADB_SERIAL="$aosp_adb_serial" \
		EXPECTED_HAL_NAME="$expected_hal_name" \
		"$aosp_shell" -lc '
		set -eu
		source build/envsetup.sh
		lunch "$AOSP_PRODUCT" >/dev/null
		cleanup() { stop_cvd >/dev/null 2>&1 || cvd stop >/dev/null 2>&1 || true; }
		adb_cvd() {
			if [ -n "${AOSP_ADB_SERIAL:-}" ]; then
				adb -s "$AOSP_ADB_SERIAL" "$@"
			else
				adb "$@"
			fi
		}
		trap cleanup EXIT INT TERM
		if [ -n "${AOSP_CUTTLEFISH_LAUNCHER:-}" ]; then
			cuttlefish_launcher=$AOSP_CUTTLEFISH_LAUNCHER
		elif command -v launch_cvd >/dev/null 2>&1; then
			cuttlefish_launcher=launch_cvd
		else
			cuttlefish_launcher=cvd
		fi
		echo "CUTTLEFISH_LAUNCHER=$cuttlefish_launcher"
		if [ "$cuttlefish_launcher" = cvd ]; then
			cvd start $AOSP_CUTTLEFISH_ARGS --daemon
		else
			"$cuttlefish_launcher" $AOSP_CUTTLEFISH_ARGS -daemon
		fi
		if [ -z "${AOSP_ADB_SERIAL:-}" ]; then
			AOSP_ADB_SERIAL=$(adb devices -l | grep -v " usb:" | sed -n "2{s/[[:space:]].*//;p;q;}")
			if [ -n "$AOSP_ADB_SERIAL" ]; then
				echo "ADB_SERIAL=$AOSP_ADB_SERIAL"
			fi
		fi
		deadline=$((SECONDS + AOSP_ADB_TIMEOUT_SECONDS))
		until adb_cvd get-state >/dev/null 2>&1; do
			if [ "$SECONDS" -ge "$deadline" ]; then
				echo "eliza-evidence: adb_wait_timeout_seconds=$AOSP_ADB_TIMEOUT_SECONDS" >&2
				exit 1
			fi
			sleep 2
		done
		boot=
		while [ "$SECONDS" -lt "$deadline" ]; do
			boot=$(adb_cvd shell getprop sys.boot_completed | tr -d "\r")
			[ "$boot" = 1 ] && break
			sleep 2
		done
		echo "sys.boot_completed=$boot"
		if [ "$boot" != 1 ]; then
			echo "eliza-evidence: boot_completed=false" >&2
			exit 1
		fi
		echo "--- adb shell lshal -i ---"
		lshal_out=$(adb_cvd shell lshal -i 2>&1 | tr -d "\r")
		echo "$lshal_out"
		echo "--- end lshal ---"
		hal_line=$(printf "%s\n" "$lshal_out" | grep -F "$EXPECTED_HAL_NAME" || true)
		if [ -z "$hal_line" ]; then
			echo "eliza-evidence: expected_hal_missing=$EXPECTED_HAL_NAME" >&2
			exit 1
		fi
		echo "HAL_LINE=$hal_line"
		# lshal -i reports availability via the "Status" column on
		# newer Android releases or the absence of "[N/A]" on older
		# releases. Treat either signal as INTERFACE_AVAILABLE.
		if printf "%s\n" "$hal_line" | grep -q "\[N/A\]"; then
			echo "eliza-evidence: hal_interface_not_available=$EXPECTED_HAL_NAME" >&2
			exit 1
		fi
		echo "HAL_REGISTERED=true"
		echo "INTERFACE_AVAILABLE=true"
		echo "HAL_SMOKE=ok"
	'
	rc=$?
	set -e
	end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	if [ "$rc" -eq 0 ]; then
		status=PASS
		hal_registered=true
		interface_available=true
	fi
	echo "eliza-evidence: ended_utc=$end_utc"
	echo "eliza-evidence: status=$status"
	echo "eliza-evidence: hal_registered=$hal_registered"
	echo "eliza-evidence: interface_available=$interface_available"
	echo "END_UTC=$end_utc"
	echo "RESULT=$rc"
	echo "$rc" >"$status_file"
	exit "$rc"
} 2>&1 | tee "$out_log"

rc=$(cat "$status_file" 2>/dev/null || echo 1)
rm -f "$status_file"
exit "$rc"
