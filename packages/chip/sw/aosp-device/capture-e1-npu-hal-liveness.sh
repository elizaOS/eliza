#!/usr/bin/env bash
# Capture booted-target e1 NPU HAL liveness evidence.
#
# This script is intentionally adb-only: it assumes the selected Android target
# is already booted and reachable. It does not fabricate lshal or peripheral
# PASS evidence, and exits non-zero unless the real chip HAL process, VINTF
# registration, /dev/e1-npu node, SELinux label, and ready property are all
# visible from the device.

set -euo pipefail

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
evidence_dir="$repo_root/docs/evidence/android"
out_log=${ELIZA_E1_NPU_HAL_LIVENESS_LOG:-"$evidence_dir/eliza_ai_soc_e1_npu_hal_liveness.log"}
serial=${AOSP_ADB_SERIAL:-}
expected_hal=${ELIZA_E1_NPU_HAL_NAME:-vendor.eliza.e1_npu@1.0::IE1Npu/default}
expected_service=${ELIZA_E1_NPU_SERVICE_PROCESS:-vendor.eliza.e1_npu@1.0-service}
expected_node=${ELIZA_E1_NPU_DEVICE_NODE:-/dev/e1-npu}
timeout_seconds=${ELIZA_E1_NPU_HAL_TIMEOUT_SECONDS:-120}

usage() {
	cat >&2 <<'USAGE'
usage: capture-e1-npu-hal-liveness.sh [options]

Capture e1 NPU HAL liveness from an already-booted adb device.

options:
  --serial=SERIAL       adb serial (default: AOSP_ADB_SERIAL or unset)
  --out=PATH            output log (default: docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log)
  --timeout=N           boot/property wait timeout in seconds (default: 120)
  --help                this message
USAGE
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--serial=*) serial=${1#*=}; shift ;;
		--out=*) out_log=${1#*=}; shift ;;
		--timeout=*) timeout_seconds=${1#*=}; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
	esac
done

case "$timeout_seconds" in
	*[!0-9]*|"") echo "error: --timeout must be numeric" >&2; exit 2 ;;
esac

adb_cmd() {
	if [ -n "$serial" ]; then
		adb -s "$serial" "$@"
	else
		adb "$@"
	fi
}

mkdir -p "$(dirname -- "$out_log")"
status_file=$(mktemp "${TMPDIR:-/tmp}/e1-npu-hal-liveness.XXXXXX")

{
	start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	echo "eliza-evidence: target=aosp artifact=eliza_ai_soc_e1_npu_hal_liveness"
	echo "eliza-evidence: claim_boundary=booted selected target HAL liveness only; not NNAPI, model execution, throughput, or phone runtime evidence"
	echo "eliza-evidence: command=$0 ${serial:+--serial=$serial}"
	echo "eliza-evidence: started_utc=$start_utc"
	echo "START_UTC=$start_utc"
	echo "EXPECTED_HAL=$expected_hal"
	echo "EXPECTED_SERVICE=$expected_service"
	echo "EXPECTED_NODE=$expected_node"

	if ! command -v adb >/dev/null 2>&1; then
		echo "PROBE_ERROR=adb not on PATH"
		echo "eliza-evidence: status=BLOCKED"
		echo "RESULT=2" >"$status_file"
		exit 2
	fi

	deadline=$(( $(date +%s) + timeout_seconds ))
	until adb_cmd get-state >/dev/null 2>&1; do
		if [ "$(date +%s)" -ge "$deadline" ]; then
			echo "PROBE_ERROR=adb device unavailable within ${timeout_seconds}s"
			echo "eliza-evidence: status=BLOCKED"
			echo "RESULT=2" >"$status_file"
			exit 2
		fi
		sleep 2
	done

	boot_completed=
	while [ "$(date +%s)" -lt "$deadline" ]; do
		boot_completed=$(adb_cmd shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
		[ "$boot_completed" = 1 ] && break
		sleep 2
	done
	echo "SYS_BOOT_COMPLETED=${boot_completed:-}"
	if [ "$boot_completed" != 1 ]; then
		echo "PROBE_ERROR=sys.boot_completed did not become 1"
		echo "eliza-evidence: status=BLOCKED"
		echo "RESULT=2" >"$status_file"
		exit 2
	fi

	ready=$(adb_cmd shell getprop vendor.e1_npu.ready 2>/dev/null | tr -d '\r')
	echo "VENDOR_E1_NPU_READY=$ready"
	if [ "$ready" != 1 ]; then
		echo "PROBE_ERROR=vendor.e1_npu.ready is '$ready', expected 1"
		echo "eliza-evidence: status=FAIL"
		echo "RESULT=1" >"$status_file"
		exit 1
	fi

	echo "--- adb shell ls -lZ $expected_node ---"
	node_line=$(adb_cmd shell "ls -lZ $expected_node" 2>&1 | tr -d '\r' || true)
	echo "$node_line"
	echo "--- end node ---"
	if ! printf '%s\n' "$node_line" | grep -Fq "$expected_node"; then
		echo "PROBE_ERROR=$expected_node missing"
		echo "eliza-evidence: status=FAIL"
		echo "RESULT=1" >"$status_file"
		exit 1
	fi
	if ! printf '%s\n' "$node_line" | grep -Fq "e1_npu_device"; then
		echo "PROBE_ERROR=$expected_node SELinux label does not include e1_npu_device"
		echo "eliza-evidence: status=FAIL"
		echo "RESULT=1" >"$status_file"
		exit 1
	fi
	echo "DEVICE_NODE_PRESENT=true"
	echo "DEVICE_NODE_LABEL=e1_npu_device"

	echo "--- adb shell pidof $expected_service ---"
	service_pid=$(adb_cmd shell "pidof $expected_service" 2>/dev/null | tr -d '\r' | awk '{print $1}')
	echo "SERVICE_PID=$service_pid"
	echo "--- end pidof ---"
	if [ -z "$service_pid" ]; then
		echo "PROBE_ERROR=$expected_service is not running"
		echo "eliza-evidence: status=FAIL"
		echo "RESULT=1" >"$status_file"
		exit 1
	fi

	echo "--- adb shell lshal -i ---"
	lshal_out=$(adb_cmd shell lshal -i 2>&1 | tr -d '\r')
	echo "$lshal_out"
	echo "--- end lshal ---"
	hal_line=$(printf '%s\n' "$lshal_out" | grep -F "$expected_hal" || true)
	if [ -z "$hal_line" ]; then
		echo "PROBE_ERROR=$expected_hal missing from lshal"
		echo "eliza-evidence: status=FAIL"
		echo "RESULT=1" >"$status_file"
		exit 1
	fi
	if printf '%s\n' "$hal_line" | grep -q "\[N/A\]"; then
		echo "PROBE_ERROR=$expected_hal reports [N/A]"
		echo "eliza-evidence: status=FAIL"
		echo "RESULT=1" >"$status_file"
		exit 1
	fi
	echo "HAL_REGISTERED=true"
	echo "INTERFACE_AVAILABLE=true"
	echo "HAL_LINE=$hal_line"

	echo "--- adb logcat -d -t 200 | grep e1_npu ---"
	adb_cmd logcat -d -t 200 2>/dev/null | tr -d '\r' | grep -i "e1_npu" || true
	echo "--- end logcat ---"

	end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	echo "eliza-evidence: ended_utc=$end_utc"
	echo "eliza-evidence: status=PASS"
	echo "END_UTC=$end_utc"
	echo "RESULT=0" >"$status_file"
} 2>&1 | tee "$out_log"

rc=$(sed -n 's/^RESULT=//p' "$status_file" | tail -n1)
rm -f "$status_file"
exit "${rc:-1}"
