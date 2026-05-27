#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
checkout="${CHIPYARD_CHECKOUT:-$repo_dir/external/chipyard}"
sim_dir="$checkout/sims/verilator"
out_dir="$repo_dir/build/chipyard/eliza_rocket"
log="$out_dir/verilator-linux-smoke.log"
evidence_dir="$repo_dir/docs/evidence/linux"
serial_boot_evidence="$evidence_dir/eliza_e1_serial_boot.log"
log_tmp=""
raw_log=""
lock_dir="$out_dir/verilator-linux-smoke.lock"
config="${CHIPYARD_CONFIG:-ElizaRocketConfig}"
config_package="${CHIPYARD_CONFIG_PACKAGE:-eliza}"
binary="${CHIPYARD_LINUX_BINARY:-}"
timeout_seconds="${CHIPYARD_LINUX_SMOKE_SECONDS:-5400}"
timeout_seconds="${CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS:-$timeout_seconds}"
timeout_cycles="${CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES:-1000000000}"
jobs="${CHIPYARD_LINUX_SMOKE_JOBS:-1}"
loadmem="${CHIPYARD_LINUX_SMOKE_LOADMEM:-1}"
disable_dramsim="${CHIPYARD_LINUX_SMOKE_DISABLE_DRAMSIM:-0}"
binary_arg="${CHIPYARD_LINUX_SMOKE_BINARY_ARG:-$binary}"
trace_verbose="${CHIPYARD_LINUX_SMOKE_TRACE_VERBOSE:-0}"
transcript_mode="${CHIPYARD_LINUX_SMOKE_TRANSCRIPT_MODE:-linux-smoke}"
extra_sim_flags="${CHIPYARD_LINUX_SMOKE_EXTRA_SIM_FLAGS:-+uart_tx_printf=1}"
if [ "$trace_verbose" = "1" ]; then
	case " $extra_sim_flags " in
		*" +verbose "*) ;;
		*) extra_sim_flags="$extra_sim_flags +verbose" ;;
	esac
fi
extra_sim_cxxflags="${CHIPYARD_LINUX_SMOKE_EXTRA_SIM_CXXFLAGS:-}"
extra_sim_ldflags="${CHIPYARD_LINUX_SMOKE_EXTRA_SIM_LDFLAGS:-}"
use_docker="${CHIPYARD_LINUX_SMOKE_USE_DOCKER:-auto}"
attempt="${CHIPYARD_LINUX_SMOKE_ATTEMPT:-1}"
simulator_default="$sim_dir/simulator-chipyard.harness-$config"
simulator_archive="$out_dir/simulator/simulator-chipyard.harness-$config"
simdram_source="$checkout/generators/testchipip/src/main/resources/testchipip/csrc/SimDRAM.cc"
default_run_target="run-binary"
default_break_sim_prereq="0"
if [ -x "$simulator_default" ] || [ -x "$simulator_archive" ]; then
	default_run_target="run-binary-fast"
	default_break_sim_prereq="1"
fi
if { [ -x "$simulator_default" ] && [ -f "$simdram_source" ] && [ "$simdram_source" -nt "$simulator_default" ]; } ||
	{ [ ! -x "$simulator_default" ] && [ -x "$simulator_archive" ] && [ -f "$simdram_source" ] && [ "$simdram_source" -nt "$simulator_archive" ]; }; then
	default_break_sim_prereq="0"
fi
run_target="${CHIPYARD_LINUX_SMOKE_RUN_TARGET:-$default_run_target}"
break_sim_prereq="${CHIPYARD_LINUX_SMOKE_BREAK_SIM_PREREQ:-$default_break_sim_prereq}"

mkdir -p "$out_dir"
mkdir -p "$evidence_dir"
if ! mkdir "$lock_dir" 2>/dev/null; then
	lock_pid=""
	if [ -f "$lock_dir/pid" ]; then
		lock_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
	fi
	lock_args=""
	if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
		lock_args="$(ps -p "$lock_pid" -o args= 2>/dev/null || true)"
	fi
	case "$lock_args" in
		*run_chipyard_eliza_linux_smoke.sh*) ;;
		*) lock_args="" ;;
	esac
	if [ -n "$lock_args" ]; then
		printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
		printf '  simulator_path: external/chipyard/sims/verilator\n'
		printf '  lock: %s\n' "${lock_dir#"$repo_dir"/}"
		printf '  - another generated AP smoke wrapper is still running with pid %s\n' "$lock_pid"
		exit 2
	fi
	printf 'STATUS: REPAIR chipyard.verilator_linux_smoke\n'
	printf '  lock: %s\n' "${lock_dir#"$repo_dir"/}"
	printf '  action: remove stale smoke lock and continue\n'
	rm -f "$lock_dir/pid"
	rmdir "$lock_dir"
	mkdir "$lock_dir"
fi
printf '%s\n' "$$" >"$lock_dir/pid"
log_tmp="$(mktemp "$out_dir/verilator-linux-smoke.XXXXXX.log.tmp")"
raw_log="$(mktemp "$out_dir/verilator-linux-smoke.XXXXXX.raw.tmp")"
cleanup_lock() {
	if [ -n "${log_tmp:-}" ] && [ -f "$log_tmp" ]; then
		rm -f "$log_tmp"
	fi
	if [ -n "${raw_log:-}" ] && [ -f "$raw_log" ]; then
		rm -f "$raw_log"
	fi
	rm -f "$lock_dir/pid"
	rmdir "$lock_dir" 2>/dev/null || true
}
quiet_linux_finished() {
	printf '%s\n' "${binary_arg:-}" | grep -F -q 'linux-poweroff-quiet' || return 1
	# shellcheck disable=SC2016 # literal Verilator finish marker; `$finish` is part of the log string.
	if [ -n "${raw_log:-}" ] && [ -f "$raw_log" ] &&
		grep -F -q 'TestDriver.v:158: Verilog $finish' "$raw_log"; then
		return 0
	fi
	sim_log="$sim_dir/output/chipyard.harness.TestHarness.$config/$(basename -- "${binary_arg:-none}").log"
	# shellcheck disable=SC2016 # literal Verilator finish marker.
	[ -f "$sim_log" ] && grep -F -q 'TestDriver.v:158: Verilog $finish' "$sim_log"
}
cleanup_signal() {
	if [ -n "${log_tmp:-}" ] && [ -f "$log_tmp" ]; then
		if [ -n "${raw_log:-}" ] && [ -f "$raw_log" ]; then
			cat "$raw_log" >>"$log_tmp"
		fi
		signal_quiet_finish=0
		if quiet_linux_finished; then
			signal_quiet_finish=1
			sim_log="$sim_dir/output/chipyard.harness.TestHarness.$config/$(basename -- "${binary_arg:-none}").log"
			# shellcheck disable=SC2016 # literal Verilator finish marker.
			if [ -f "$sim_log" ] && ! grep -F -q 'TestDriver.v:158: Verilog $finish' "$log_tmp"; then
				cat "$sim_log" >>"$log_tmp"
			fi
		fi
		{
			printf 'eliza-evidence: raw_transcript_end\n'
			printf 'eliza-evidence: exit_code=143\n'
			printf 'eliza-evidence: signal=TERM\n'
			if [ "$signal_quiet_finish" = "1" ]; then
				printf 'eliza-evidence: quiet_linux_completion=1\n'
				printf 'eliza-evidence: status=PASS\n'
			else
				printf 'eliza-evidence: status=BLOCKED\n'
			fi
		} >>"$log_tmp"
		mv "$log_tmp" "$log"
		log_tmp=""
	fi
	if [ -n "${raw_log:-}" ] && [ -f "$raw_log" ]; then
		rm -f "$raw_log"
		raw_log=""
	fi
	rm -f "$lock_dir/pid"
	rmdir "$lock_dir" 2>/dev/null || true
	exit 143
}
trap cleanup_lock EXIT
trap cleanup_signal HUP INT TERM

if [ -z "$binary" ]; then
	payload_export="$(python3 "$repo_dir/scripts/locate_chipyard_linux_payload.py" --export-env --require-preferred || true)"
	case "$payload_export" in
		export\ CHIPYARD_LINUX_BINARY=*)
			eval "$payload_export"
			binary="${CHIPYARD_LINUX_BINARY:-}"
			;;
	esac
fi

if [ "$use_docker" != "0" ] && [ -x "$repo_dir/scripts/run_chipyard_eliza_linux_smoke_docker.sh" ]; then
	host_system="$(uname -s 2>/dev/null || printf unknown)"
	host_machine="$(uname -m 2>/dev/null || printf unknown)"
	if [ "$use_docker" = "1" ] || [ "$host_system" = "Darwin" ] || [ "$host_machine" = "arm64" ] || [ "$host_machine" = "aarch64" ]; then
		exec "$repo_dir/scripts/run_chipyard_eliza_linux_smoke_docker.sh"
	fi
fi

if [ -z "$binary" ]; then
	printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
	printf '  simulator_path: external/chipyard/sims/verilator\n'
	printf '  next_command: cd external/chipyard/sims/verilator && source ../../env.sh && make CONFIG=%s CONFIG_PACKAGE=%s BINARY=$CHIPYARD_LINUX_BINARY LOADMEM=1 run-binary\n' "$config" "$config_package"
	printf '  - CHIPYARD_LINUX_BINARY is unset; provide a real OpenSBI/Linux ELF payload\n'
	exit 2
fi

if [ ! -f "$binary" ]; then
	printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
	printf '  simulator_path: external/chipyard/sims/verilator\n'
	printf '  - CHIPYARD_LINUX_BINARY does not point to a file: %s\n' "$binary"
	exit 2
fi
if [ -z "$binary_arg" ]; then
	binary_arg="$binary"
fi

	if [ "$(basename -- "$binary")" = "eliza-e1-linux-smoke-bin-nodisk" ]; then
		kfrag="$repo_dir/sw/firemarshal/eliza-e1-linux-smoke/eliza-e1-linux-smoke-kfrag"
		linux_config="$checkout/software/firemarshal/images/firechip/eliza-e1-linux-smoke/linux_config"
		freshness_manifest="$checkout/software/firemarshal/images/firechip/eliza-e1-linux-smoke/payload_freshness_manifest.json"
		enforced_disabled_options=" CONFIG_EFI CONFIG_EFI_STUB CONFIG_EFI_ESRT CONFIG_EFI_RUNTIME_WRAPPERS CONFIG_EFI_EARLYCON CONFIG_PORTABLE CONFIG_STRICT_KERNEL_RWX CONFIG_STRICT_MODULE_RWX "
		kfrag_cmdline=""
		linux_cmdline=""
		missing_kfrag_options=""
	if [ -f "$kfrag" ] && [ -f "$linux_config" ]; then
			while IFS= read -r kfrag_line || [ -n "$kfrag_line" ]; do
				[ -n "$kfrag_line" ] || continue
				case "$kfrag_line" in
					\#\ CONFIG_*\ is\ not\ set)
						kfrag_symbol="$(printf '%s\n' "$kfrag_line" | sed -n 's/^# \\(CONFIG_[^ ]*\\) is not set$/\\1/p')"
						case "$enforced_disabled_options" in
							*" $kfrag_symbol "*) ;;
							*) continue ;;
						esac
						;;
					\#*) continue ;;
				esac
				if ! grep -F -x -q -- "$kfrag_line" "$linux_config"; then
					missing_kfrag_options="${missing_kfrag_options}${missing_kfrag_options:+, }$kfrag_line"
			fi
		done <"$kfrag"
	fi
	if [ -f "$kfrag" ] && [ -f "$binary" ] && [ -n "$missing_kfrag_options" ]; then
		printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
		printf '  simulator_path: external/chipyard/sims/verilator\n'
		printf '  - preferred FireMarshal payload is missing current %s option(s): %s\n' "${kfrag#"$repo_dir"/}" "$missing_kfrag_options"
		printf '  next_command: scripts/build_firemarshal_eliza_linux_smoke_payload.sh\n'
		exit 2
	fi
	if [ -f "$kfrag" ] && [ -f "$linux_config" ]; then
		kfrag_cmdline="$(sed -n 's/^CONFIG_CMDLINE=//p' "$kfrag" | tail -n 1 | tr -d '"')"
		linux_cmdline="$(sed -n 's/^CONFIG_CMDLINE=//p' "$linux_config" | tail -n 1 | tr -d '"')"
		if [ -n "$kfrag_cmdline" ] && [ -n "$linux_cmdline" ] &&
			[ "$kfrag_cmdline" != "$linux_cmdline" ]; then
			printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
			printf '  simulator_path: external/chipyard/sims/verilator\n'
			printf '  - preferred FireMarshal payload linux_config cmdline is stale\n'
			printf '    built:  %s\n' "$linux_cmdline"
			printf '    source: %s\n' "$kfrag_cmdline"
			printf '  next_command: scripts/build_firemarshal_eliza_linux_smoke_payload.sh\n'
			exit 2
		fi
	fi
	ELIZA_REPO_DIR="$repo_dir" \
		ELIZA_CHIPYARD_CHECKOUT="$checkout" \
		ELIZA_FIREMARSHAL_PAYLOAD="$binary" \
		ELIZA_FIREMARSHAL_FRESHNESS_MANIFEST="$freshness_manifest" \
		python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

repo = Path(os.environ["ELIZA_REPO_DIR"]).resolve()
checkout = Path(os.environ["ELIZA_CHIPYARD_CHECKOUT"]).resolve()
payload = Path(os.environ["ELIZA_FIREMARSHAL_PAYLOAD"]).resolve()
manifest = Path(os.environ["ELIZA_FIREMARSHAL_FRESHNESS_MANIFEST"]).resolve()
workload_dir = repo / "sw/firemarshal/eliza-e1-linux-smoke"
inputs = [
    repo / "sw/firemarshal/eliza-e1-linux-smoke.json",
    workload_dir / "eliza-e1-linux-smoke-kfrag",
    workload_dir / "eliza-e1-linux-smoke.sh",
    workload_dir / "build-hwprobe.sh",
    workload_dir / "eliza-e1-linux-smoke-overlay/etc/init.d/S00eliza-e1-linux-smoke",
    workload_dir / "opensbi-eliza_defconfig",
    workload_dir / "eliza-riscv-hwprobe.c",
    workload_dir / "eliza-riscv-hwprobe",
    workload_dir / "e1-npu-ml-smoke",
]
for optional in (
    workload_dir / "eliza-skip-unaligned-probe.patch",
    workload_dir / "opensbi-eliza-platform-fast-final.patch",
):
    if optional.exists():
        inputs.append(optional)


def rel(path):
    try:
        return str(path.relative_to(repo))
    except ValueError:
        return str(path)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def block(reason):
    print("STATUS: BLOCKED chipyard.verilator_linux_smoke")
    print("  simulator_path: external/chipyard/sims/verilator")
    print(f"  - preferred FireMarshal payload freshness is not accepted: {reason}")
    print("  next_command: scripts/build_firemarshal_eliza_linux_smoke_payload.sh")
    raise SystemExit(2)


preferred_payload = (
    checkout
    / "software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk"
).resolve()
if payload != preferred_payload:
    raise SystemExit(0)
if not manifest.is_file():
    block(f"missing {rel(manifest)}")
try:
    data = json.loads(manifest.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    block(f"invalid {rel(manifest)}: {exc}")
if not isinstance(data, dict) or data.get("schema") != "eliza.firemarshal_linux_smoke_payload_freshness.v1":
    block(f"{rel(manifest)} has an unsupported schema")
payload_record = data.get("payload")
if not isinstance(payload_record, dict) or payload_record.get("sha256") != sha256(payload):
    block(f"{rel(manifest)} payload digest does not match {rel(payload)}")
input_records = data.get("inputs")
if not isinstance(input_records, dict):
    block(f"{rel(manifest)} has no input digest map")
missing = [rel(path) for path in inputs if not path.is_file()]
if missing:
    block("missing current input(s): " + ", ".join(missing[:6]) + ("" if len(missing) <= 6 else f", +{len(missing) - 6} more"))
mismatched = []
for path in inputs:
    record = input_records.get(rel(path))
    if not isinstance(record, dict) or record.get("sha256") != sha256(path):
        mismatched.append(rel(path))
if mismatched:
    block("manifest digest mismatch for current input(s): " + ", ".join(mismatched[:6]) + ("" if len(mismatched) <= 6 else f", +{len(mismatched) - 6} more"))
PY
fi

case "$run_target" in
	run-binary|run-binary-fast) ;;
	*)
		printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
		printf '  simulator_path: external/chipyard/sims/verilator\n'
		printf '  - unsupported CHIPYARD_LINUX_SMOKE_RUN_TARGET: %s\n' "$run_target"
		exit 2
		;;
esac
case "$break_sim_prereq" in
	0|1) ;;
	*)
		printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
		printf '  simulator_path: external/chipyard/sims/verilator\n'
		printf '  - unsupported CHIPYARD_LINUX_SMOKE_BREAK_SIM_PREREQ: %s\n' "$break_sim_prereq"
		exit 2
		;;
esac
case "$disable_dramsim" in
	0|1) ;;
	*)
		printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
		printf '  simulator_path: external/chipyard/sims/verilator\n'
		printf '  - unsupported CHIPYARD_LINUX_SMOKE_DISABLE_DRAMSIM: %s\n' "$disable_dramsim"
		exit 2
		;;
esac
case "$transcript_mode" in
	linux-smoke|ap-benchmarks) ;;
	*)
		printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
		printf '  simulator_path: external/chipyard/sims/verilator\n'
		printf '  - unsupported CHIPYARD_LINUX_SMOKE_TRANSCRIPT_MODE: %s\n' "$transcript_mode"
		exit 2
		;;
esac

cd "$repo_dir"
python3 scripts/check_chipyard_verilator_preflight.py
python3 scripts/check_chipyard_verilator_linux_smoke.py --repair-stale-generated
python3 scripts/check_chipyard_payload_path.py || true

cd "$sim_dir"
# shellcheck disable=SC1091
. ../../env.sh
riscv_is_complete() {
	[ -n "${1:-}" ] &&
		[ -f "$1/include/fesvr/memif.h" ] &&
		[ -f "$1/include/riscv/cfg.h" ] &&
		[ -f "$1/lib/libfesvr.a" ] &&
		[ -f "$1/lib/libriscv.a" ]
}
if ! riscv_is_complete "${RISCV:-}"; then
	for riscv_root in \
		"$repo_dir/tools" \
		"$repo_dir/external/riscv-tools-linux-x64" \
		"$repo_dir/external/riscv64-linux-gnu/usr" \
		"$repo_dir/external/xpack-riscv-none-elf-gcc-15.2.0-1"; do
		if riscv_is_complete "$riscv_root"; then
			RISCV="$riscv_root"
			export RISCV
			break
		fi
	done
fi
for tool_bin in \
	"$repo_dir/tools/bin" \
	"$repo_dir/external/riscv-tools-linux-x64/bin" \
	"$repo_dir/external/riscv64-linux-gnu/usr/bin" \
	"$repo_dir/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin" \
	"$repo_dir/external/chipyard/toolchains/riscv-tools/riscv-isa-sim/build" \
	"$repo_dir/external/deb-tools/dtc/usr/bin"; do
	if [ -d "$tool_bin" ]; then
		PATH="$tool_bin:$PATH"
	fi
done
export PATH
if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
	PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
	export PATH
fi
if [ -z "$extra_sim_cxxflags" ] && [ -n "${RISCV:-}" ] && [ -f "$RISCV/include/fesvr/memif.h" ]; then
	extra_sim_cxxflags="-I$RISCV/include"
fi
if [ -z "$extra_sim_ldflags" ] && [ -n "${RISCV:-}" ] && [ -d "$RISCV/lib" ]; then
	extra_sim_ldflags="-L$RISCV/lib -Wl,-rpath,$RISCV/lib"
fi

generated_dir="$sim_dir/generated-src/chipyard.harness.TestHarness.$config"
bootrom_src="$checkout/generators/testchipip/src/main/resources/testchipip/bootrom"
simdram_target="$checkout/generators/testchipip/target/scala-2.13/classes/testchipip/csrc/SimDRAM.cc"
mkdir -p "$generated_dir"
for bootrom_img in bootrom.rv64.img bootrom.rv32.img; do
	if [ -f "$bootrom_src/$bootrom_img" ]; then
		cp -f "$bootrom_src/$bootrom_img" "$generated_dir/$bootrom_img"
	fi
done
if [ -f "$simdram_source" ]; then
	mkdir -p "$(dirname -- "$simdram_target")"
	if [ ! -f "$simdram_target" ] || ! cmp -s "$simdram_source" "$simdram_target"; then
		cp -f "$simdram_source" "$simdram_target"
	fi
fi

command_text="make CONFIG=$config CONFIG_PACKAGE=$config_package BINARY=$binary LOADMEM=1 TIMEOUT_CYCLES=$timeout_cycles $run_target"
loadmem_arg="$loadmem"
if [ "$loadmem_arg" = "1" ]; then
	loadmem_arg=1
fi
command_text="make -j $jobs CONFIG=$config CONFIG_PACKAGE=$config_package BINARY=$binary_arg LOADMEM=$loadmem_arg TIMEOUT_CYCLES=$timeout_cycles"
command_text="$command_text DISABLE_DRAMSIM=$disable_dramsim"
if [ -n "$extra_sim_flags" ]; then
	command_text="$command_text EXTRA_SIM_FLAGS='$extra_sim_flags'"
fi
if [ -n "$extra_sim_cxxflags" ]; then
	command_text="$command_text EXTRA_SIM_CXXFLAGS='$extra_sim_cxxflags'"
fi
if [ -n "$extra_sim_ldflags" ]; then
	command_text="$command_text EXTRA_SIM_LDFLAGS='$extra_sim_ldflags'"
fi
if [ "$break_sim_prereq" = "1" ]; then
	command_text="$command_text BREAK_SIM_PREREQ=1"
fi
command_text="$command_text $run_target"
{
	printf 'eliza-evidence: target=generated_chipyard_ap\n'
	printf 'eliza-evidence: wrapper=scripts/run_chipyard_eliza_linux_smoke.sh\n'
	printf 'eliza-evidence: attempt=%s\n' "$attempt"
	printf 'eliza-evidence: command=%s\n' "$command_text"
	printf 'eliza-evidence: payload=%s\n' "$binary"
	printf 'eliza-evidence: binary_arg=%s\n' "$binary_arg"
	printf 'eliza-evidence: timeout_after_seconds=%s\n' "$timeout_seconds"
	printf 'eliza-evidence: timeout_cycles=%s\n' "$timeout_cycles"
	printf 'eliza-evidence: run_target=%s\n' "$run_target"
	printf 'eliza-evidence: transcript_mode=%s\n' "$transcript_mode"
	printf 'eliza-evidence: jobs=%s\n' "$jobs"
	printf 'eliza-evidence: loadmem=%s\n' "$loadmem"
	printf 'eliza-evidence: break_sim_prereq=%s\n' "$break_sim_prereq"
	printf 'eliza-evidence: disable_dramsim=%s\n' "$disable_dramsim"
	printf 'eliza-evidence: trace_verbose=%s\n' "$trace_verbose"
	if [ -n "$extra_sim_flags" ]; then
		printf 'eliza-evidence: extra_sim_flags=%s\n' "$extra_sim_flags"
	fi
	if [ -n "$extra_sim_cxxflags" ]; then
		printf 'eliza-evidence: extra_sim_cxxflags=%s\n' "$extra_sim_cxxflags"
	fi
	if [ -n "$extra_sim_ldflags" ]; then
		printf 'eliza-evidence: extra_sim_ldflags=%s\n' "$extra_sim_ldflags"
	fi
	printf 'eliza-evidence: note=software reference transcripts are excluded from generated AP evidence intake\n'
	printf 'eliza-evidence: raw_transcript_begin\n'
} >"$log_tmp"
: >"$raw_log"
trace_out="$sim_dir/output/chipyard.harness.TestHarness.$config/$(basename -- "$binary_arg").out"
if { [ "$run_target" = "run-binary-fast" ] || [ "$trace_verbose" = "1" ]; } && [ -f "$trace_out" ]; then
	rm -f "$trace_out"
	printf 'eliza-evidence: removed_stale_trace=%s\n' "${trace_out#"$repo_dir"/}" >>"$log_tmp"
fi

set +e
if [ "$break_sim_prereq" = "1" ]; then
	python3 "$repo_dir/scripts/run_with_timeout.py" \
		--timeout-seconds "$timeout_seconds" \
		--label chipyard-generated-ap-linux-smoke \
		-- make -j "$jobs" CONFIG="$config" CONFIG_PACKAGE="$config_package" BINARY="$binary_arg" LOADMEM="$loadmem" TIMEOUT_CYCLES="$timeout_cycles" DISABLE_DRAMSIM="$disable_dramsim" EXTRA_SIM_FLAGS="$extra_sim_flags" EXTRA_SIM_CXXFLAGS="$extra_sim_cxxflags" EXTRA_SIM_LDFLAGS="$extra_sim_ldflags" BREAK_SIM_PREREQ=1 "$run_target" >>"$raw_log" 2>&1
else
	python3 "$repo_dir/scripts/run_with_timeout.py" \
		--timeout-seconds "$timeout_seconds" \
		--label chipyard-generated-ap-linux-smoke \
		-- make -j "$jobs" CONFIG="$config" CONFIG_PACKAGE="$config_package" BINARY="$binary_arg" LOADMEM="$loadmem" TIMEOUT_CYCLES="$timeout_cycles" DISABLE_DRAMSIM="$disable_dramsim" EXTRA_SIM_FLAGS="$extra_sim_flags" EXTRA_SIM_CXXFLAGS="$extra_sim_cxxflags" EXTRA_SIM_LDFLAGS="$extra_sim_ldflags" "$run_target" >>"$raw_log" 2>&1
fi
status=$?
set -e
cat "$raw_log" >>"$log_tmp"
kernel_panic=0
if grep -E -q 'Kernel panic - not syncing|panic - not syncing' "$raw_log"; then
	kernel_panic=1
fi
testdriver_success_finish=0
if quiet_linux_finished; then
	testdriver_success_finish=1
fi

{
	printf 'eliza-evidence: raw_transcript_end\n'
	printf 'eliza-evidence: exit_code=%s\n' "$status"
	if [ "$kernel_panic" = "1" ]; then
		printf 'eliza-evidence: kernel_panic=1\n'
		printf 'eliza-evidence: status=BLOCKED\n'
	elif [ "$testdriver_success_finish" = "1" ]; then
		printf 'eliza-evidence: quiet_linux_completion=1\n'
		printf 'eliza-evidence: status=PASS\n'
	elif [ "$status" -eq 0 ]; then
		printf 'eliza-evidence: status=PASS\n'
	else
		printf 'eliza-evidence: status=BLOCKED\n'
	fi
} >>"$log_tmp"
mv "$log_tmp" "$log"

tail -n 80 "$log"

if { [ "$status" -ne 0 ] && [ "$testdriver_success_finish" != "1" ]; } || [ "$kernel_panic" = "1" ]; then
	if [ "${CHIPYARD_LINUX_SMOKE_RETRY_GENERATED:-1}" = "1" ] && [ "$attempt" = "1" ] && \
		[ "$kernel_panic" != "1" ] && \
		python3 "$repo_dir/scripts/check_chipyard_verilator_linux_smoke.py" \
			--classify-generated-artifact-failure "$log"; then
		printf 'STATUS: REPAIR chipyard.verilator_linux_smoke\n'
		printf '  reason: generated Verilator model artifact failure in %s\n' "${log#"$repo_dir"/}"
		printf '  action: remove stale/partial generated simulator outputs and retry once\n'
		python3 "$repo_dir/scripts/check_chipyard_verilator_linux_smoke.py" --repair-stale-generated >/dev/null
		CHIPYARD_LINUX_SMOKE_ATTEMPT=2 CHIPYARD_LINUX_SMOKE_RETRY_GENERATED=0 exec "$repo_dir/scripts/run_chipyard_eliza_linux_smoke.sh"
	fi
	printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke\n'
	printf '  simulator_path: external/chipyard/sims/verilator\n'
	printf '  log: build/chipyard/eliza_rocket/verilator-linux-smoke.log\n'
	printf '  next_command: CHIPYARD_LINUX_SMOKE_RETRY_GENERATED=1 %s\n' "${0#"$repo_dir"/}"
	if [ "$kernel_panic" = "1" ]; then
		printf '  - generated AP %s reached a Linux kernel panic\n' "$run_target"
	else
		printf '  - generated AP %s exited with status %s\n' "$run_target" "$status"
	fi
	exit 2
fi

cd "$repo_dir"
if [ "$transcript_mode" = "ap-benchmarks" ]; then
	{
		printf 'STATUS: PASS chipyard.verilator_ap_benchmarks\n'
		printf 'eliza-evidence: ap_benchmark_wrapper_marker=present\n'
	} >>"$log"
	printf 'STATUS: PASS chipyard.verilator_ap_benchmarks\n'
	printf '  log: build/chipyard/eliza_rocket/verilator-linux-smoke.log\n'
	printf '  note: AP benchmark transcript marker validation is performed by scripts/capture_cpu_ap_evidence.py intake ap-benchmarks\n'
	exit 0
fi

CHIPYARD_LINUX_BINARY="$binary" python3 scripts/check_chipyard_verilator_linux_smoke.py
{
	printf 'eliza-evidence: target=linux artifact=eliza_e1_serial_boot\n'
	printf 'eliza-evidence: claim_boundary=generated_chipyard_ap_serial_boot_transcript_only_not_silicon_or_board_evidence\n'
	printf 'eliza-evidence: source=%s\n' "${log#"$repo_dir"/}"
	printf 'eliza-evidence: command=%s\n' "$command_text"
	printf 'eliza-evidence: payload=%s\n' "$binary"
	printf 'eliza-evidence: raw_transcript_begin\n'
	cat "$log"
	printf 'eliza-evidence: raw_transcript_end\n'
	printf 'eliza-evidence: status=PASS\n'
} >"$serial_boot_evidence"
printf 'STATUS: PASS linux.serial_boot_evidence\n'
printf '  evidence: %s\n' "${serial_boot_evidence#"$repo_dir"/}"
