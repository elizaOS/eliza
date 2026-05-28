#!/usr/bin/env sh
# shellcheck disable=SC2016
set -eu

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)
if [ -d "$repo_root/tools/bin" ]; then
	PATH="$repo_root/tools/bin${PATH:+:$PATH}"
fi
if [ -d "$repo_root/.venv/bin" ]; then
	PATH="$repo_root/.venv/bin${PATH:+:$PATH}"
fi
report="${ANDROID_SIM_BOOT_REPORT:-$repo_root/build/reports/android_sim_boot.json}"
evidence_dir="$repo_root/docs/evidence/android"
aosp_dir=${AOSP_DIR:-}
aosp_dir_source=unset
if [ -n "$aosp_dir" ]; then
	aosp_dir_source=env
elif [ "${ELIZA_DISABLE_AOSP_DIR_DEFAULTS:-0}" != "1" ] &&
	[ -f /home/shaw/aosp/build/envsetup.sh ] &&
	[ -d /home/shaw/aosp/device ]; then
	aosp_dir=/home/shaw/aosp
	aosp_dir_source=repo-default
fi
aosp_shell=${AOSP_SHELL:-bash}
aosp_product=${AOSP_PRODUCT:-eliza_openagent_ai_soc_phone-trunk_staging-userdebug}
aosp_cuttlefish_product=${AOSP_CUTTLEFISH_PRODUCT:-eliza_cf_riscv64_phone-trunk_staging-userdebug}
aosp_cuttlefish_args=${AOSP_CUTTLEFISH_ARGS:---cpus=4 --memory_mb=8192 --gpu_mode=none}
aosp_cuttlefish_launcher=${AOSP_CUTTLEFISH_LAUNCHER:-}
aosp_adb_timeout_seconds=${AOSP_ADB_TIMEOUT_SECONDS:-180}
run_cuttlefish=0
run_cts=0
run_vts=0
run_qemu=0
run_renode=0
require_full_evidence=1
host_os=$(uname -s 2>/dev/null || printf unknown)
host_arch=$(uname -m 2>/dev/null || printf unknown)
capture_failures=0

usage() {
	cat >&2 <<'EOF'
usage: AOSP_DIR=/path/to/aosp scripts/boot_android_simulator.sh [--run-cuttlefish] [--run-cts] [--run-vts] [--run-qemu] [--run-renode] [--build-only]

Runs the Eliza Android simulator evidence sequence against an external AOSP
checkout. By default the final gate attempts every AOSP evidence category
tracked by docs/android/bsp-log-evidence-manifest.json and
scripts/check_software_bsp.py: lunch, vendorimage, VINTF, SELinux policy,
CTS/VTS intake, and virtual-device smoke evidence for Cuttlefish, QEMU, and
Renode. Use --build-only to stop before virtual-device smoke and compatibility
runs without claiming Android boot.
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
			aosp_dir_source=arg
			shift 2
			;;
		--run-cuttlefish)
			run_cuttlefish=1
			shift
			;;
		--run-cts)
			run_cts=1
			shift
			;;
		--run-vts)
			run_vts=1
			shift
			;;
		--run-qemu)
			run_qemu=1
			shift
			;;
		--run-renode)
			run_renode=1
			shift
			;;
		--build-only)
			require_full_evidence=0
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

if [ "$require_full_evidence" -eq 1 ]; then
	run_cuttlefish=1
	run_cts=1
	run_vts=1
	run_qemu=1
	run_renode=1
fi

mkdir -p "$(dirname "$report")" "$evidence_dir"

json_escape() {
	printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

json_bool() {
	if [ "$1" -eq 1 ]; then
		printf 'true'
	else
		printf 'false'
	fi
}

linux_requirements_json() {
	python3 - <<'PY'
import json

print(json.dumps([
    "Linux host with hardware virtualization enabled",
    "AOSP_DIR set to an AOSP checkout containing build/envsetup.sh and device/",
    "/dev/kvm present and readable/writable by the running user",
    "repo available on PATH when syncing or bootstrapping a checkout",
    "adb available on PATH when running Cuttlefish boot smoke",
    "launch_cvd or cvd available on PATH or under AOSP_DIR/out/host/linux-x86/bin",
    "user in kvm/cvdnetwork/render groups, or equivalent host permissions",
], indent=2))
PY
}

handoff_commands_json() {
	python3 - <<'PY'
import json

print(json.dumps([
    "python3 scripts/check_aosp_linux_preflight.py --write-report",
    "AOSP_DIR=$AOSP_DIR scripts/run_aosp_linux_handoff.sh --build-only",
    "sw/aosp-device/import-aosp-device.sh --check \"$AOSP_DIR\"",
    "make aosp-bsp-check",
    "AOSP_DIR=$AOSP_DIR scripts/boot_android_simulator.sh --run-cuttlefish --run-cts --run-vts --run-qemu --run-renode",
    "python3 scripts/check_android_sim_boot.py",
    "python3 scripts/check_software_bsp.py aosp --require-evidence",
], indent=2))
PY
}

findings_json() {
	status=$1
	reason=$2
	next=$3
	host_requirements=$4
	python3 - "$status" "$reason" "$next" "$host_requirements" <<'PY'
import json
import sys

status, reason, next_step, host_requirements_text = sys.argv[1:5]

def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback

findings = []
try:
    host_requirements = json.loads(host_requirements_text)
except json.JSONDecodeError:
    host_requirements = {}
for item in host_requirements.get("missing", []):
    text = str(item)
    findings.append({
        "code": f"android_sim_host_{code_from_text(text, 'missing_requirement')}",
        "severity": "blocker",
        "message": text,
        "evidence": "host_requirements.missing",
        "next_step": next_step,
    })
if status != "pass" and reason:
    findings.append({
        "code": f"android_sim_status_{code_from_text(reason, 'blocked')}",
        "severity": "blocker" if status == "blocked" else "fail",
        "message": reason,
        "evidence": "android_sim_boot.status",
        "next_step": next_step,
    })
print(json.dumps(findings, indent=2))
PY
}

host_requirements_json() {
	python3 - "$host_os" "$host_arch" "$run_cuttlefish" "$run_qemu" "$run_renode" "${aosp_dir:-}" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys

host_os, host_arch = sys.argv[1], sys.argv[2]
run_cuttlefish = sys.argv[3] == "1"
run_qemu = sys.argv[4] == "1"
run_renode = sys.argv[5] == "1"
aosp_dir_text = sys.argv[6]
aosp_dir = Path(aosp_dir_text).expanduser().resolve() if aosp_dir_text else None
missing = []
if host_os != "Linux":
    missing.append("Linux host required for local Android virtual-device launches")
if aosp_dir is None:
    missing.append("AOSP_DIR is not set")
else:
    if not (aosp_dir / "build/envsetup.sh").is_file():
        missing.append(f"{aosp_dir}/build/envsetup.sh is missing")
    if not (aosp_dir / "device").is_dir():
        missing.append(f"{aosp_dir}/device is missing")
kvm = Path("/dev/kvm")
if not kvm.exists():
    missing.append("/dev/kvm is missing")
elif not os.access(kvm, os.R_OK | os.W_OK):
    missing.append("/dev/kvm is not readable and writable by this user")
cuttlefish_candidates = ["launch_cvd", "cvd"]
cuttlefish_found = any(shutil.which(tool) for tool in cuttlefish_candidates)
if not cuttlefish_found and aosp_dir is not None:
    cuttlefish_found = any(
        (aosp_dir / "out/host/linux-x86/bin" / tool).exists()
        for tool in cuttlefish_candidates
    )
if run_cuttlefish and not cuttlefish_found:
    missing.append(
        "Cuttlefish launcher not found; expected launch_cvd or cvd on PATH "
        "or under AOSP_DIR/out/host/linux-x86/bin"
    )
has_existing_checkout = (
    aosp_dir is not None
    and (aosp_dir / "build/envsetup.sh").is_file()
    and (aosp_dir / "device").is_dir()
)
repo_path = shutil.which("repo")
if repo_path is None:
    if not has_existing_checkout:
        missing.append("repo not found on PATH")
else:
    try:
        repo_version = subprocess.run(
            [repo_path, "--version"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        if not has_existing_checkout:
            missing.append(f"repo launcher at {repo_path} could not run --version")
    else:
        if repo_version.returncode != 0:
            if not has_existing_checkout:
                missing.append(f"repo launcher at {repo_path} failed --version")
        elif "<repo not installed>" in repo_version.stdout and not has_existing_checkout:
            missing.append(f"repo launcher found at {repo_path}, but repo is not installed")
if run_cuttlefish and shutil.which("adb") is None:
    missing.append("adb not found on PATH")
if run_qemu and shutil.which("qemu-system-riscv64") is None:
    missing.append("qemu-system-riscv64 not found on PATH")
if run_renode and shutil.which("renode") is None:
    missing.append("renode not found on PATH")
print(json.dumps({
    "host_os": host_os,
    "host_arch": host_arch,
    "missing": missing,
}))
PY
}

evidence_json() {
	mode=$1
	python3 - "$mode" <<'PY'
import json
import sys
from pathlib import Path

mode = sys.argv[1]
root = Path.cwd()
sys.path.insert(0, str(root / "scripts"))
import check_software_bsp

full = check_software_bsp.TARGETS["aosp"]["evidence"]
runtime = {
    "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log",
    "docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log",
    "docs/evidence/android/cuttlefish_riscv64_smoke.log",
    "docs/evidence/android/qemu_riscv64_smoke.log",
    "docs/evidence/android/renode_e1_soc_smoke.log",
}
build = [path for path in full if path not in runtime]
print(json.dumps(build if mode == "build" else full, indent=2))
PY
}

write_report() {
	status=$1
	reason=$2
	next=$3
	host_requirements=$(host_requirements_json)
	linux_requirements=$(linux_requirements_json)
	handoff_commands=$(handoff_commands_json)
	findings=$(findings_json "$status" "$reason" "$next" "$host_requirements")
	required_evidence=$(evidence_json full)
	attempted_evidence=$(evidence_json build)
	if [ "$require_full_evidence" -eq 1 ]; then
		attempted_evidence=$(evidence_json full)
	fi
	tmp="$report.$$.$(date +%s).tmp"
	cat > "$tmp" <<EOF
{
  "schema": "eliza.android_sim_boot.v1",
  "status": $(json_escape "$status"),
  "reason": $(json_escape "$reason"),
  "next_step": $(json_escape "$next"),
  "aosp_dir": $(json_escape "${aosp_dir:-}"),
  "aosp_dir_source": $(json_escape "$aosp_dir_source"),
  "aosp_product": $(json_escape "$aosp_product"),
  "run_cuttlefish": $(json_bool "$run_cuttlefish"),
  "run_cts": $(json_bool "$run_cts"),
  "run_vts": $(json_bool "$run_vts"),
  "run_qemu": $(json_bool "$run_qemu"),
  "run_renode": $(json_bool "$run_renode"),
  "require_full_evidence": $(json_bool "$require_full_evidence"),
  "evidence_manifest": "docs/android/bsp-log-evidence-manifest.json",
  "software_bsp_checker": "scripts/check_software_bsp.py aosp --require-evidence",
  "required_evidence": $required_evidence,
  "attempted_evidence": $attempted_evidence,
  "host_requirements": $host_requirements,
  "findings": $findings,
  "linux_requirements": $linux_requirements,
  "handoff_commands": $handoff_commands,
  "claim_boundary": "Android virtual-device evidence is software/reference evidence only; it is not e1-chip hardware ABI proof, CDD compliance, GMS certification, or a full Android compatibility claim."
}
EOF
	mv "$tmp" "$report"
}

stage_passed() {
	path=$1
	grep -q 'RESULT=0' "$path" 2>/dev/null && grep -q 'eliza-evidence: status=PASS' "$path" 2>/dev/null
}

record_stage_result() {
	path=$1
	if stage_passed "$path"; then
		return 0
	fi
	capture_failures=$((capture_failures + 1))
	return 1
}

run_helper_stage() {
	mode=$1
	path=$2
	set +e
	AOSP_PRODUCT="$aosp_product" AOSP_SHELL="$aosp_shell" "$repo_root/sw/aosp-device/capture-aosp-evidence.sh" "$aosp_dir" "$mode"
	rc=$?
	set -e
	if [ "$rc" -ne 0 ]; then
		capture_failures=$((capture_failures + 1))
		return 1
	fi
	record_stage_result "$path" || true
}

capture_aosp_shell() {
	artifact=$1
	out=$2
	command_label=$3
	command_script=$4
	metadata_kind=$5
	rcfile=$(mktemp "${TMPDIR:-/tmp}/android_sim_boot_stage.$$.$artifact.XXXXXX")
	start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	status=FAIL
	rm -f "$rcfile"
	{
		echo "eliza-evidence: target=aosp artifact=$artifact"
		echo "eliza-evidence: external_tree=$aosp_dir"
		echo "eliza-evidence: command=$command_label"
		echo "EXTERNAL_TREE=$aosp_dir"
		echo "COMMAND=$command_label"
		echo "START_UTC=$start_utc"
		echo "COMPATIBILITY_CLAIM=none"
		if [ "$metadata_kind" = "virtual" ]; then
			echo "BOOT_CLAIM=none"
			echo "SCHEMA=docs/android/boot-transcript.schema.json"
		fi
		echo "eliza-evidence: started_utc=$start_utc"
		cd "$aosp_dir"
		set +e
		env AOSP_PRODUCT="$aosp_product" \
			AOSP_TARGET_PRODUCT="${AOSP_TARGET_PRODUCT:-eliza_ai_soc}" \
			AOSP_CUTTLEFISH_ARGS="$aosp_cuttlefish_args" \
			AOSP_CUTTLEFISH_LAUNCHER="$aosp_cuttlefish_launcher" \
			AOSP_ADB_TIMEOUT_SECONDS="$aosp_adb_timeout_seconds" \
			AOSP_QEMU_SMOKE_COMMAND="${AOSP_QEMU_SMOKE_COMMAND:-}" \
			AOSP_RENODE_SMOKE_COMMAND="${AOSP_RENODE_SMOKE_COMMAND:-}" \
			"$aosp_shell" -lc "$command_script"
		rc=$?
		set -e
		end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
		if [ "$rc" -eq 0 ]; then
			status=PASS
		fi
		echo "eliza-evidence: ended_utc=$end_utc"
		echo "eliza-evidence: status=$status"
		echo "END_UTC=$end_utc"
		echo "RESULT=$rc"
		printf '%s' "$rc" > "$rcfile"
	} 2>&1 | tee "$out"
	if [ -f "$rcfile" ]; then
		rc=$(cat "$rcfile")
		rm -f "$rcfile"
	else
		rc=1
	fi
	if [ "$rc" -ne 0 ]; then
		capture_failures=$((capture_failures + 1))
		return 1
	fi
	record_stage_result "$out" || true
}

if [ -z "$aosp_dir" ]; then
	write_report \
		"blocked" \
		"AOSP_DIR is not set, so there is no external AOSP checkout to import/build/boot." \
		"Set AOSP_DIR=/path/to/aosp on a Linux host with Android virtual-device support, then rerun this script."
	echo "BLOCKED: AOSP_DIR is not set; wrote $report"
	exit 2
fi

if [ ! -f "$aosp_dir/build/envsetup.sh" ] || [ ! -d "$aosp_dir/device" ]; then
	write_report \
		"blocked" \
		"$aosp_dir does not look like an AOSP checkout." \
		"Provide an AOSP checkout containing build/envsetup.sh and device/."
	echo "BLOCKED: $aosp_dir does not look like an AOSP checkout; wrote $report"
	exit 2
fi

if [ ! -x "$repo_root/sw/aosp-device/import-aosp-device.sh" ]; then
	write_report "failed" "AOSP import helper is not executable." "chmod +x sw/aosp-device/import-aosp-device.sh"
	echo "FAIL: AOSP import helper is not executable; wrote $report"
	exit 1
fi

"$repo_root/sw/aosp-device/import-aosp-device.sh" "$aosp_dir"

run_helper_stage lunch "$evidence_dir/eliza_ai_soc_lunch.log" || true
run_helper_stage vendorimage "$evidence_dir/eliza_ai_soc_vendorimage.log" || true
run_helper_stage checkvintf "$evidence_dir/eliza_ai_soc_checkvintf.log" || true
run_helper_stage sepolicy-build "$evidence_dir/eliza_ai_soc_sepolicy_build.log" || true
run_helper_stage selinux-neverallow "$evidence_dir/eliza_ai_soc_selinux_neverallow.log" || true

if [ "$require_full_evidence" -eq 0 ]; then
	python3 "$repo_root/scripts/check_software_bsp.py" aosp
	write_report \
		"blocked" \
		"Android build-only evidence captured; virtual-device smoke and CTS/VTS compatibility intake were not requested." \
		"Rerun without --build-only to attempt full Android simulator evidence."
	echo "BLOCKED: Android build-only evidence captured; wrote $report"
	exit 2
fi

if [ "$run_cts" -eq 1 ] || [ "$run_vts" -eq 1 ]; then
	capture_aosp_shell \
		eliza_ai_soc_cts_vts_plan \
		"$evidence_dir/eliza_ai_soc_cts_vts_plan.log" \
		"bounded CTS/VTS smoke-scope intake and optional Tradefed module listing" \
		'source build/envsetup.sh &&
			lunch "$AOSP_PRODUCT" >/dev/null &&
			echo "CTS_SCOPE=smoke_only" &&
			echo "VTS_SCOPE=vintf_selinux_hal_manager_only" &&
			echo "EXCLUDED_MODULES=full_cts,full_vts,device_specific" &&
			echo "RESULT_DIR=${ANDROID_HOST_OUT:-out/host/linux-x86}/cts-vts-plan" &&
			echo "CTS_PLAN=bounded_smoke_scope_recorded" &&
			echo "VTS_PLAN=vintf_selinux_hal_manager_scope_recorded" &&
			echo "cts-tradefed list modules" &&
			if command -v cts-tradefed >/dev/null 2>&1; then
				cts-tradefed list modules | sed -n "1,40p"
			elif [ -x out/host/linux-x86/cts/android-cts/tools/cts-tradefed ]; then
				out/host/linux-x86/cts/android-cts/tools/cts-tradefed list modules | sed -n "1,40p"
			else
				echo "CTS_TRADEFED_STATUS=absent_for_bounded_plan"
			fi &&
			echo "vts-tradefed list modules" &&
			if command -v vts-tradefed >/dev/null 2>&1; then
				vts-tradefed list modules | sed -n "1,40p"
			elif [ -x out/host/linux-x86/vts/android-vts/tools/vts-tradefed ]; then
				out/host/linux-x86/vts/android-vts/tools/vts-tradefed list modules | sed -n "1,40p"
			else
				echo "VTS_TRADEFED_STATUS=absent_for_bounded_plan"
			fi' \
		build || true
fi

if [ "$run_cuttlefish" -eq 1 ]; then
	set +e
		AOSP_PRODUCT="$aosp_cuttlefish_product" \
			AOSP_SHELL="$aosp_shell" \
		AOSP_CUTTLEFISH_ARGS="$aosp_cuttlefish_args" \
		AOSP_CUTTLEFISH_LAUNCHER="$aosp_cuttlefish_launcher" \
		AOSP_ADB_TIMEOUT_SECONDS="$aosp_adb_timeout_seconds" \
		"$repo_root/sw/aosp-device/check-cvd-hal-smoke.sh" "$aosp_dir"
	hal_rc=$?
	set -e
	if [ "$hal_rc" -ne 0 ]; then
		capture_failures=$((capture_failures + 1))
	else
		record_stage_result "$evidence_dir/eliza_ai_soc_cvd_hal_smoke.log" || true
	fi

	capture_aosp_shell \
		cuttlefish_riscv64_smoke \
		"$evidence_dir/cuttlefish_riscv64_smoke.log" \
			"launch_cvd or cvd create followed by adb shell getprop smoke checks" \
			'source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				echo "AOSP_CUTTLEFISH_PRODUCT=$AOSP_PRODUCT" &&
			cleanup() { stop_cvd >/dev/null 2>&1 || cvd stop >/dev/null 2>&1 || true; } &&
			trap cleanup EXIT INT TERM &&
			if [ -n "$AOSP_CUTTLEFISH_LAUNCHER" ]; then
				cuttlefish_launcher=$AOSP_CUTTLEFISH_LAUNCHER
			elif command -v launch_cvd >/dev/null 2>&1; then
				cuttlefish_launcher=launch_cvd
			else
				cuttlefish_launcher=cvd
			fi &&
			echo "CUTTLEFISH_LAUNCHER=$cuttlefish_launcher" &&
			if [ "$cuttlefish_launcher" = cvd ]; then
				cvd_host_arg= &&
				cvd_product_arg= &&
				if [ -d /usr/lib/cuttlefish-common/bin ]; then
					cvd_host_root="out/eliza-cvd-host"
					rm -rf "$cvd_host_root"
					mkdir -p "$cvd_host_root/bin"
					for cvd_tool in /usr/lib/cuttlefish-common/bin/*; do
						ln -s "$cvd_tool" "$cvd_host_root/bin/$(basename "$cvd_tool")"
					done
					for cvd_dir in etc lib64 usr; do
						[ -e "/usr/lib/cuttlefish-common/$cvd_dir" ] &&
							ln -s "/usr/lib/cuttlefish-common/$cvd_dir" "$cvd_host_root/$cvd_dir"
					done
					cvd_host_arg="--host_path=$cvd_host_root"
				fi &&
				if [ -n "${ANDROID_PRODUCT_OUT:-}" ] && [ -d "$ANDROID_PRODUCT_OUT" ]; then
					cvd_product_arg="--product_path=$ANDROID_PRODUCT_OUT"
				fi &&
				if [ -n "${ANDROID_PRODUCT_OUT:-}" ]; then
					echo "ANDROID_PRODUCT_OUT=$ANDROID_PRODUCT_OUT"
					for cvd_image in fetcher_config.json system.img vendor.img boot.img; do
						if [ ! -s "$ANDROID_PRODUCT_OUT/$cvd_image" ]; then
							echo "CVD_IMAGE_SET=missing"
							echo "MISSING_CVD_IMAGE=$ANDROID_PRODUCT_OUT/$cvd_image"
							echo "NEXT_STEP=build the cuttlefish product image set before launching cvd"
							exit 1
						fi
					done
				fi &&
				cvd create ${cvd_host_arg:-} ${cvd_product_arg:-} $AOSP_CUTTLEFISH_ARGS --daemon
			else
				"$cuttlefish_launcher" $AOSP_CUTTLEFISH_ARGS -daemon
			fi &&
			deadline=$((SECONDS + AOSP_ADB_TIMEOUT_SECONDS)) &&
			until adb get-state >/dev/null 2>&1; do
				if [ "$SECONDS" -ge "$deadline" ]; then
					echo "virtual-device wait exceeded ${AOSP_ADB_TIMEOUT_SECONDS}s" &&
					exit 1
				fi
				sleep 2
			done &&
			echo "adb shell true" &&
			adb shell true &&
			echo "adb shell getprop ro.product.cpu.abi" &&
			abi=$(adb shell getprop ro.product.cpu.abi | tr -d "\r") &&
			echo "ro.product.cpu.abi=$abi" &&
			echo "adb shell getprop sys.boot_completed" &&
			boot= &&
			while [ "$SECONDS" -lt "$deadline" ]; do
				boot=$(adb shell getprop sys.boot_completed | tr -d "\r") &&
				[ "$boot" = 1 ] && break
				sleep 2
			done &&
			echo "sys.boot_completed=$boot" &&
			[ "$abi" = riscv64 ] && [ "$boot" = 1 ]' \
		virtual || true
fi

if [ "$run_qemu" -eq 1 ]; then
	capture_aosp_shell \
		qemu_riscv64_smoke \
		"$evidence_dir/qemu_riscv64_smoke.log" \
		"${AOSP_QEMU_SMOKE_COMMAND:-AOSP_QEMU_SMOKE_COMMAND}" \
		'source build/envsetup.sh &&
			lunch "$AOSP_PRODUCT" >/dev/null &&
			echo "TARGET_PRODUCT=${AOSP_TARGET_PRODUCT:-eliza_ai_soc}" &&
			if [ -z "${AOSP_QEMU_SMOKE_COMMAND:-}" ]; then
				echo "error: set AOSP_QEMU_SMOKE_COMMAND to a real qemu-system-riscv64 boot smoke that records sys.boot_completed=1 or console boot markers" >&2
				exit 2
			fi &&
			eval "$AOSP_QEMU_SMOKE_COMMAND"' \
		virtual || true
fi

if [ "$run_renode" -eq 1 ]; then
	capture_aosp_shell \
		renode_e1_soc_smoke \
		"$evidence_dir/renode_e1_soc_smoke.log" \
		"${AOSP_RENODE_SMOKE_COMMAND:-AOSP_RENODE_SMOKE_COMMAND}" \
		'source build/envsetup.sh &&
			lunch "$AOSP_PRODUCT" >/dev/null &&
			echo "TARGET_PRODUCT=${AOSP_TARGET_PRODUCT:-eliza_ai_soc}" &&
			if [ -z "${AOSP_RENODE_SMOKE_COMMAND:-}" ]; then
				echo "error: set AOSP_RENODE_SMOKE_COMMAND to a real Renode Android-capable firmware/kernel handoff smoke" >&2
				exit 2
			fi &&
			eval "$AOSP_RENODE_SMOKE_COMMAND"' \
		virtual || true
fi

set +e
python3 "$repo_root/scripts/check_software_bsp.py" aosp --require-evidence
check_rc=$?
set -e
if [ "$check_rc" -eq 0 ] && [ "$capture_failures" -eq 0 ]; then
	write_report "pass" "Android simulator evidence captured and validated." "none"
	echo "PASS: Android simulator evidence captured and validated; wrote $report"
	exit 0
fi

write_report \
	"failed" \
	"Android simulator evidence did not satisfy the required AOSP BSP evidence manifest." \
	"Inspect docs/evidence/android/*.log, fix failing or missing stages, then rerun this script."
echo "FAIL: Android simulator evidence did not satisfy the required AOSP BSP evidence manifest; wrote $report"
exit 1
