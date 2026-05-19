#!/usr/bin/env bash
# cuttlefish-boot-gate.sh
#
# Assert + evidence-capture script for the Cuttlefish riscv64 boot harness.
# Runs after launch-cuttlefish-riscv64.sh, collects the canonical
# riscv64 boot markers, and writes a transcript to
# docs/evidence/android/cuttlefish_riscv64_boot.log with eliza-evidence:
# status=PASS|FAIL markers + RESULT=0|1 + per-assertion KEY=value lines.
#
# Claim boundary: virtual-device boot smoke only. This is not e1_soc/AP
# silicon evidence and is not an Android compatibility claim.

set -euo pipefail

usage() {
	cat >&2 <<'USAGE'
usage: cuttlefish-boot-gate.sh [options]

options:
  --out=PATH              evidence transcript output path
                          (default: <repo>/docs/evidence/android/cuttlefish_riscv64_boot.log)
  --manifest=PATH         AOSP manifest XML from Task 28; recorded with sha256
  --adb-serial=SERIAL     adb -s <serial> for multi-device hosts
  --runtime-dir=PATH      Cuttlefish runtime directory (default: ~/cuttlefish_runtime)
  --help                  this message

Assertions:
  ro.product.cpu.abi      == riscv64
  ro.product.cpu.abilist  contains riscv64
  uname -m                == riscv64
  sys.boot_completed      == 1
  getenforce              == Enforcing
  kernel.log              contains "Run /init as init process" and no panic
  BUILD_ID                non-empty
  manifest sha256         present when --manifest is provided
USAGE
}

out=
manifest=
adb_serial=
runtime_dir="$HOME/cuttlefish_runtime"

while [ "$#" -gt 0 ]; do
	case "$1" in
		--out=*) out=${1#*=}; shift ;;
		--manifest=*) manifest=${1#*=}; shift ;;
		--adb-serial=*) adb_serial=${1#*=}; shift ;;
		--runtime-dir=*) runtime_dir=${1#*=}; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
	esac
done

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -z "$out" ]; then
	out="$repo_root/docs/evidence/android/cuttlefish_riscv64_boot.log"
fi
mkdir -p "$(dirname "$out")"

adb_cvd() {
	if [ -n "$adb_serial" ]; then
		adb -s "$adb_serial" "$@"
	else
		adb "$@"
	fi
}

result=0
fails=()

assert_eq() {
	# $1 key, $2 actual, $3 expected
	local key=$1 actual=$2 expected=$3
	printf '%s=%s\n' "$key" "$actual"
	if [ "$actual" != "$expected" ]; then
		fails+=("$key expected '$expected' got '$actual'")
		return 1
	fi
}

assert_contains() {
	local key=$1 actual=$2 needle=$3
	printf '%s=%s\n' "$key" "$actual"
	case "$actual" in
		*"$needle"*) return 0 ;;
	esac
	fails+=("$key expected to contain '$needle' got '$actual'")
	return 1
}

start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
result_file=$(mktemp)
trap 'rm -f "$result_file"' EXIT
echo 0 > "$result_file"

emit() {
	echo "eliza-evidence: target=aosp artifact=cuttlefish_riscv64_boot"
	echo "eliza-evidence: claim_boundary=virtual_device_smoke_only_not_boot_or_compatibility_evidence"
	echo "eliza-evidence: command=cuttlefish-boot-gate.sh"
	echo "BOOT_CLAIM=virtual_device_only"
	echo "COMPATIBILITY_CLAIM=none"
	echo "START_UTC=$start_utc"
	echo "eliza-evidence: started_utc=$start_utc"
	echo "ADB_SERIAL=${adb_serial:-default}"
	echo "RUNTIME_DIR=$runtime_dir"

	if ! command -v adb >/dev/null 2>&1; then
		echo "error: adb not on PATH" >&2
		result=1
	fi

	if [ "$result" -eq 0 ]; then
		abi=$(adb_cvd shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r' || true)
		assert_eq ro.product.cpu.abi "$abi" riscv64 || result=1

		abilist=$(adb_cvd shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r' || true)
		assert_contains ro.product.cpu.abilist "$abilist" riscv64 || result=1

		uname_m=$(adb_cvd shell uname -m 2>/dev/null | tr -d '\r' || true)
		assert_eq uname_m "$uname_m" riscv64 || result=1

		boot=$(adb_cvd shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
		assert_eq sys.boot_completed "$boot" 1 || result=1

		selinux=$(adb_cvd shell getenforce 2>/dev/null | tr -d '\r' || true)
		assert_eq getenforce "$selinux" Enforcing || result=1

		build_id=$(adb_cvd shell getprop ro.build.id 2>/dev/null | tr -d '\r' || true)
		printf 'BUILD_ID=%s\n' "$build_id"
		if [ -z "$build_id" ]; then
			fails+=("BUILD_ID empty")
			result=1
		fi

		sdk=$(adb_cvd shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r' || true)
		printf 'ro.build.version.sdk=%s\n' "$sdk"
	fi

	kernel_log="$runtime_dir/kernel.log"
	if [ -f "$kernel_log" ]; then
		printf 'KERNEL_LOG=%s\n' "$kernel_log"
		if grep -q 'Run /init as init process' "$kernel_log"; then
			echo "KERNEL_INIT_MARKER=present"
		else
			fails+=("kernel.log missing 'Run /init as init process'")
			result=1
			echo "KERNEL_INIT_MARKER=absent"
		fi
		if grep -qE 'Kernel panic|Oops:' "$kernel_log"; then
			fails+=("kernel.log contains panic/Oops")
			result=1
			echo "KERNEL_PANIC=true"
		else
			echo "KERNEL_PANIC=false"
		fi
	else
		echo "KERNEL_LOG=missing:$kernel_log"
		fails+=("$kernel_log not present")
		result=1
	fi

	if [ -n "$manifest" ]; then
		if [ -f "$manifest" ]; then
			manifest_sha=$(sha256sum "$manifest" | awk '{print $1}')
			printf 'MANIFEST_PATH=%s\n' "$manifest"
			printf 'MANIFEST_SHA256=%s\n' "$manifest_sha"
		else
			echo "MANIFEST_PATH=missing:$manifest"
			fails+=("manifest $manifest not found")
			result=1
		fi
	else
		echo "MANIFEST_PATH=unset"
	fi

	end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	echo "END_UTC=$end_utc"
	echo "eliza-evidence: ended_utc=$end_utc"

	if [ "$result" -eq 0 ]; then
		status=PASS
	else
		status=FAIL
		for line in "${fails[@]}"; do
			printf 'FAILURE=%s\n' "$line"
		done
	fi
	echo "eliza-evidence: status=$status"
	echo "RESULT=$result"
	echo "$result" > "$result_file"
}

emit | tee "$out"

final_result=$(cat "$result_file")
exit "$final_result"
