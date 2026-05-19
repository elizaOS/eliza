#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)
aosp_dir=${AOSP_DIR:-}
build_only=0
preflight_only=0
skip_preflight=0

usage() {
	cat >&2 <<'EOF'
usage: AOSP_DIR=/path/to/aosp scripts/run_aosp_linux_handoff.sh [--build-only] [--preflight-only] [--skip-preflight]

Runs the executable AOSP Linux handoff sequence:
  1. host preflight report
  2. AOSP device import check/import
  3. Android evidence capture driver
  4. Android simulator report check
  5. strict AOSP BSP evidence check

This script does not fabricate docs/evidence/android logs. On macOS or Linux
hosts missing AOSP_DIR/KVM/Cuttlefish, it exits BLOCKED after writing the
preflight report.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--aosp-dir)
			if [ "$#" -lt 2 ]; then
				usage
				exit 2
			fi
			aosp_dir=$2
			shift 2
			;;
		--build-only)
			build_only=1
			shift
			;;
		--preflight-only)
			preflight_only=1
			shift
			;;
		--skip-preflight)
			skip_preflight=1
			shift
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			usage
			exit 2
			;;
	esac
done

if [ -z "$aosp_dir" ]; then
	set +e
	AOSP_DIR='' python3 "$repo_root/scripts/check_aosp_linux_preflight.py" --write-report
	set -e
	echo "STATUS: BLOCKED aosp.linux-handoff - set AOSP_DIR=/path/to/aosp"
	exit 2
fi

if [ "$skip_preflight" -eq 0 ]; then
	set +e
	python3 "$repo_root/scripts/check_aosp_linux_preflight.py" \
		--aosp-dir "$aosp_dir" \
		--write-report
	preflight_rc=$?
	set -e
	if [ "$preflight_rc" -ne 0 ]; then
		echo "STATUS: BLOCKED aosp.linux-handoff - preflight did not pass; see build/reports/aosp_linux_preflight.json"
		exit 2
	fi
fi

if [ "$preflight_only" -eq 1 ]; then
	echo "STATUS: PASS aosp.linux-handoff-preflight"
	exit 0
fi

"$repo_root/sw/aosp-device/import-aosp-device.sh" --check "$aosp_dir"
"$repo_root/sw/aosp-device/import-aosp-device.sh" "$aosp_dir"

if [ "$build_only" -eq 1 ]; then
	AOSP_DIR="$aosp_dir" "$repo_root/scripts/boot_android_simulator.sh" --build-only
else
	AOSP_DIR="$aosp_dir" "$repo_root/scripts/boot_android_simulator.sh" \
		--run-cuttlefish --run-cts --run-vts --run-qemu --run-renode
fi

python3 "$repo_root/scripts/check_android_sim_boot.py"
python3 "$repo_root/scripts/check_software_bsp.py" aosp --require-evidence
