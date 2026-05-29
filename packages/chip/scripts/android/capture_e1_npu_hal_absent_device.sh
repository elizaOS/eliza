#!/usr/bin/env bash
# Capture the local fail-closed HAL probe for an absent e1-npu device node.

set -euo pipefail

repo_root="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
out="${1:-$repo_root/docs/evidence/android/e1-npu/absent-device-probe.log}"
device_path="${E1_NPU_ABSENT_DEVICE_PATH:-/tmp/definitely-missing-e1-npu}"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/e1-npu-hal-probe.XXXXXX")"
tmp_log="$tmpdir/absent-device-probe.log"
status_file="$tmpdir/status"
probe="$tmpdir/e1_npu_probe"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$(dirname -- "$out")"
start_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status=FAIL
rc=0

set +e
{
	echo "eliza-evidence: target=local_host artifact=e1_npu_absent_device_probe"
	echo "eliza-evidence: claim_boundary=no_nnapi_acceleration_without_android_nnapi_hal_and_device_evidence"
	echo "EXTERNAL_TREE=$repo_root"
	echo "COMMAND=c++ e1_npu_runtime.cc e1_npu_probe_main.cc && e1_npu_probe --device $device_path"
	echo "START_UTC=$start_utc"
	echo "BOOT_CLAIM=none"
	echo "COMPATIBILITY_CLAIM=none"
	echo "NNAPI_ACCELERATION_CLAIM=none"
	cd "$repo_root"
	c++ -std=c++17 -Wall -Wextra -Werror \
		sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_runtime.cc \
		sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_probe_main.cc \
		-I sw/aosp-device/device/eliza/eliza_ai_soc/hal \
		-o "$probe" &&
		"$probe" --device "$device_path"
	rc=$?
	if [ "$rc" -eq 0 ]; then
		echo "e1_npu_status=unsupported"
	fi
	end_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	if [ "$rc" -eq 0 ]; then
		status=PASS
	fi
	echo "eliza-evidence: ended_utc=$end_utc"
	echo "eliza-evidence: status=$status"
	echo "END_UTC=$end_utc"
	echo "RESULT=$rc"
	echo "$rc" >"$status_file"
} >"$tmp_log" 2>&1
rc="$(cat "$status_file" 2>/dev/null || echo 1)"
set -e

mv "$tmp_log" "$out"
printf 'e1-npu absent-device probe log: %s\n' "$out"
exit "$rc"
