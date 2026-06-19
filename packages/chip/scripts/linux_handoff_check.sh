#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

report_dir="$repo_root/build/reports"
log="$report_dir/linux_handoff_check.log"
mkdir -p "$report_dir"
: > "$log"

run_required() {
	name=$1
	shift
	printf '== %s ==\n' "$name" | tee -a "$log"
	tmp="$report_dir/linux_handoff_check.$$.tmp"
	set +e
	"$@" >"$tmp" 2>&1
	rc=$?
	set -e
	tee -a "$log" <"$tmp"
	rm -f "$tmp"
	if [ "$rc" != "0" ]; then
		printf 'FAIL: %s exited %s\n' "$name" "$rc" | tee -a "$log"
		exit "$rc"
	fi
}

run_optional_blocking() {
	name=$1
	shift
	printf '== %s ==\n' "$name" | tee -a "$log"
	tmp="$report_dir/linux_handoff_check.$$.tmp"
	set +e
	"$@" >"$tmp" 2>&1
	rc=$?
	set -e
	tee -a "$log" <"$tmp"
	output=$(cat "$tmp")
	rm -f "$tmp"
	case "$rc" in
		0)
			printf 'PASS: %s\n' "$name" | tee -a "$log"
			;;
		2)
			printf 'BLOCKED: %s\n' "$name" | tee -a "$log"
			;;
		*)
			if printf '%s\n' "$output" | grep -Eq 'STATUS: BLOCKED|^BLOCKED:'; then
				printf 'BLOCKED: %s\n' "$name" | tee -a "$log"
			else
				printf 'FAIL: %s exited %s\n' "$name" "$rc" | tee -a "$log"
				exit "$rc"
			fi
			;;
	esac
}

run_required "python compile" python3 -m py_compile \
	scripts/run_mvp_simulator.py \
	scripts/check_mvp_simulator.py \
	scripts/check_chipyard_verilator_preflight.py \
	scripts/check_chipyard_verilator_linux_smoke.py \
	scripts/check_chipyard_generated_linux_contract.py \
	scripts/locate_chipyard_linux_payload.py \
	scripts/test_chipyard_linux_payload_locator.py \
	scripts/check_android_sim_boot.py \
	scripts/check_qemu_linux_payload_status.py \
	scripts/fetch_qemu_linux_payload.py

run_required "qemu status tests" python3 scripts/test_qemu_smoke_status.py
run_required "mvp simulator status tests" python3 scripts/test_mvp_simulator_status.py
run_required "android simulator status tests" python3 scripts/test_android_sim_boot_status.py
run_required "software BSP parser tests" python3 scripts/test_software_bsp_checks.py
run_required "Chipyard Linux payload locator tests" python3 scripts/test_chipyard_linux_payload_locator.py
run_required "qemu linux payload fetch" python3 scripts/fetch_qemu_linux_payload.py
run_required "qemu linux OS boot smoke" env QEMU_OS_BOOT_SECONDS="${QEMU_OS_BOOT_SECONDS:-30}" scripts/run_qemu.sh --check-os
run_required "qemu linux payload status" python3 scripts/check_qemu_linux_payload_status.py

run_optional_blocking "Chipyard Verilator preflight" python3 scripts/check_chipyard_verilator_preflight.py
run_optional_blocking "Chipyard generated AP gate" python3 scripts/check_chipyard_generator_manifest.py --require-generated
run_optional_blocking "Chipyard generated Linux contract gate" python3 scripts/check_chipyard_generated_linux_contract.py
run_optional_blocking "Chipyard Linux payload locator" python3 scripts/locate_chipyard_linux_payload.py --require
run_optional_blocking "Chipyard payload path gate" python3 scripts/check_chipyard_payload_path.py
run_optional_blocking "Chipyard Verilator Linux smoke gate" python3 scripts/check_chipyard_verilator_linux_smoke.py
run_optional_blocking "CPU/AP Linux evidence gate" python3 scripts/check_cpu_ap_evidence.py --require-evidence
run_optional_blocking "Android simulator gate" scripts/boot_android_simulator.sh --run-cuttlefish --run-cts --run-vts
run_optional_blocking "MVP simulator run" python3 scripts/run_mvp_simulator.py
run_optional_blocking "MVP simulator report check" python3 scripts/check_mvp_simulator.py

printf 'linux handoff check complete; log: %s\n' "${log#"$repo_root"/}" | tee -a "$log"
