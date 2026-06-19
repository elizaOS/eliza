#!/usr/bin/env bash
# Capture the complete Android e1-NPU proof bundle from a connected target.

set -euo pipefail

repo_root="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
aosp_tree="${AOSP_TREE:-${AOSP_DIR:-}}"
if [ -z "$aosp_tree" ] && [ -d /home/shaw/aosp ]; then
	aosp_tree=/home/shaw/aosp
fi
stages="${E1_NPU_ANDROID_PROOF_STAGES:-preflight,absent,vintf,nnapi,cts,vts,assemble,check}"

die() {
	printf 'capture_e1_npu_android_proof_bundle: %s\n' "$*" >&2
	exit 2
}

has_stage() {
	case ",$stages," in
		*",$1,"*) return 0 ;;
		*) return 1 ;;
	esac
}

require_aosp_tree() {
	[ -n "$aosp_tree" ] || die "AOSP_TREE or AOSP_DIR must point at a built AOSP tree"
	[ -d "$aosp_tree" ] || die "AOSP tree does not exist: $aosp_tree"
}

run_stage() {
	name=$1
	shift
	printf '== e1-npu android proof stage: %s ==\n' "$name"
	"$@"
}

cd "$repo_root"

if has_stage preflight; then
	printf 'preflight remediation: scripts/android/build_cts_vts_tradefed.sh builds missing CTS/VTS Tradefed bundles\n'
	run_stage preflight python3 scripts/check_e1_npu_android_proof_bundle_preflight.py \
		--aosp-tree "$aosp_tree"
fi

if has_stage absent; then
	run_stage absent-device scripts/android/capture_e1_npu_hal_absent_device.sh
fi

if has_stage vintf; then
	require_aosp_tree
	run_stage vintf sw/aosp-device/capture-aosp-evidence.sh "$aosp_tree" checkvintf
fi

if has_stage nnapi; then
	run_stage nnapi env E1_NPU_REFRESH_ANDROID_MANIFEST=0 \
		scripts/android/capture_e1_npu_nnapi_evidence.sh
fi

if has_stage cts; then
	require_aosp_tree
	run_stage cts env AOSP_TREE="$aosp_tree" E1_NPU_REFRESH_ANDROID_MANIFEST=0 \
		scripts/android/run_cts_smoke.sh
fi

if has_stage vts; then
	require_aosp_tree
	run_stage vts env AOSP_TREE="$aosp_tree" E1_NPU_REFRESH_ANDROID_MANIFEST=0 \
		scripts/android/run_vts_smoke.sh
fi

if has_stage assemble; then
	set +e
	run_stage assemble python3 scripts/assemble_e1_npu_android_proof_manifest.py
	assemble_rc=$?
	set -e
	if [ "$assemble_rc" -ne 0 ] && [ "$assemble_rc" -ne 2 ]; then
		exit "$assemble_rc"
	fi
fi

if has_stage check; then
	set +e
	run_stage nnapi-proof-check python3 scripts/check_e1_npu_nnapi_proof.py --probe-adb
	nnapi_check_rc=$?
	run_stage android-proof-manifest-check python3 scripts/check_e1_npu_android_proof_manifest.py \
		--manifest docs/evidence/android/e1-npu/android-proof-manifest.json \
		--require-pass
	manifest_check_rc=$?
	set -e
	if [ "$nnapi_check_rc" -ne 0 ]; then
		exit "$nnapi_check_rc"
	fi
	if [ "$manifest_check_rc" -ne 0 ]; then
		exit "$manifest_check_rc"
	fi
fi
