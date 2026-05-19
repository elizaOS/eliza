#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
checkout="${CHIPYARD_CHECKOUT:-$repo_dir/external/chipyard}"
sim_dir="$checkout/sims/verilator"
out_dir="$repo_dir/build/chipyard/eliza_rocket"
log="$out_dir/verilator-linux-smoke.log"
log_tmp="$out_dir/verilator-linux-smoke.log.tmp"
raw_log="$out_dir/verilator-linux-smoke.raw.tmp"
lock_dir="$out_dir/verilator-linux-smoke.lock"
config="${CHIPYARD_CONFIG:-ElizaRocketConfig}"
config_package="${CHIPYARD_CONFIG_PACKAGE:-eliza}"
binary="${CHIPYARD_LINUX_BINARY:-}"
timeout_seconds="${CHIPYARD_LINUX_SMOKE_SECONDS:-180}"
timeout_seconds="${CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS:-$timeout_seconds}"
timeout_cycles="${CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES:-10000000}"
run_target="${CHIPYARD_LINUX_SMOKE_RUN_TARGET:-run-binary}"
jobs="${CHIPYARD_LINUX_SMOKE_JOBS:-1}"
loadmem="${CHIPYARD_LINUX_SMOKE_LOADMEM:-1}"
binary_arg="${CHIPYARD_LINUX_SMOKE_BINARY_ARG:-$binary}"
extra_sim_flags="${CHIPYARD_LINUX_SMOKE_EXTRA_SIM_FLAGS:-+custom_boot_pin=1 +uart_tx_printf=1}"
extra_sim_cxxflags="${CHIPYARD_LINUX_SMOKE_EXTRA_SIM_CXXFLAGS:-}"
extra_sim_ldflags="${CHIPYARD_LINUX_SMOKE_EXTRA_SIM_LDFLAGS:-}"
break_sim_prereq="${CHIPYARD_LINUX_SMOKE_BREAK_SIM_PREREQ:-0}"
use_docker="${CHIPYARD_LINUX_SMOKE_USE_DOCKER:-auto}"
attempt="${CHIPYARD_LINUX_SMOKE_ATTEMPT:-1}"

mkdir -p "$out_dir"
if ! mkdir "$lock_dir" 2>/dev/null; then
	lock_pid=""
	if [ -f "$lock_dir/pid" ]; then
		lock_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
	fi
	if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
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
cleanup_lock() {
	rm -f "$lock_dir/pid"
	rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup_lock EXIT HUP INT TERM

if [ -z "$binary" ]; then
	payload_export="$(python3 "$repo_dir/scripts/locate_chipyard_linux_payload.py" --export-env)"
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
	printf "  next_command: cd external/chipyard/sims/verilator && source ../../env.sh && make CONFIG=%s CONFIG_PACKAGE=%s BINARY=\\$CHIPYARD_LINUX_BINARY LOADMEM=1 run-binary\n" "$config" "$config_package"
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
mkdir -p "$generated_dir"
for bootrom_img in bootrom.rv64.img bootrom.rv32.img; do
	if [ -f "$bootrom_src/$bootrom_img" ]; then
		cp -f "$bootrom_src/$bootrom_img" "$generated_dir/$bootrom_img"
	fi
done

command_text="make CONFIG=$config CONFIG_PACKAGE=$config_package BINARY=$binary LOADMEM=1 TIMEOUT_CYCLES=$timeout_cycles $run_target"
loadmem_arg="$loadmem"
if [ "$loadmem_arg" = "1" ]; then
	loadmem_arg=1
fi
command_text="make -j $jobs CONFIG=$config CONFIG_PACKAGE=$config_package BINARY=$binary_arg LOADMEM=$loadmem_arg TIMEOUT_CYCLES=$timeout_cycles"
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
	printf 'eliza-evidence: jobs=%s\n' "$jobs"
	printf 'eliza-evidence: loadmem=%s\n' "$loadmem"
	printf 'eliza-evidence: break_sim_prereq=%s\n' "$break_sim_prereq"
	if [ -n "$extra_sim_flags" ]; then
		printf 'eliza-evidence: extra_sim_flags=%s\n' "$extra_sim_flags"
	fi
	if [ -n "$extra_sim_cxxflags" ]; then
		printf 'eliza-evidence: extra_sim_cxxflags=%s\n' "$extra_sim_cxxflags"
	fi
	if [ -n "$extra_sim_ldflags" ]; then
		printf 'eliza-evidence: extra_sim_ldflags=%s\n' "$extra_sim_ldflags"
	fi
	printf 'eliza-evidence: note=qemu-virt and Renode reference transcripts do not satisfy this generated AP Linux smoke\n'
	printf 'eliza-evidence: raw_transcript_begin\n'
} >"$log_tmp"
: >"$raw_log"

set +e
if [ "$break_sim_prereq" = "1" ]; then
	python3 "$repo_dir/scripts/run_with_timeout.py" \
		--timeout-seconds "$timeout_seconds" \
		--label chipyard-generated-ap-linux-smoke \
		-- make -j "$jobs" CONFIG="$config" CONFIG_PACKAGE="$config_package" BINARY="$binary_arg" LOADMEM="$loadmem" TIMEOUT_CYCLES="$timeout_cycles" EXTRA_SIM_FLAGS="$extra_sim_flags" EXTRA_SIM_CXXFLAGS="$extra_sim_cxxflags" EXTRA_SIM_LDFLAGS="$extra_sim_ldflags" BREAK_SIM_PREREQ=1 "$run_target" >>"$raw_log" 2>&1
else
	python3 "$repo_dir/scripts/run_with_timeout.py" \
		--timeout-seconds "$timeout_seconds" \
		--label chipyard-generated-ap-linux-smoke \
		-- make -j "$jobs" CONFIG="$config" CONFIG_PACKAGE="$config_package" BINARY="$binary_arg" LOADMEM="$loadmem" TIMEOUT_CYCLES="$timeout_cycles" EXTRA_SIM_FLAGS="$extra_sim_flags" EXTRA_SIM_CXXFLAGS="$extra_sim_cxxflags" EXTRA_SIM_LDFLAGS="$extra_sim_ldflags" "$run_target" >>"$raw_log" 2>&1
fi
status=$?
set -e
cat "$raw_log" >>"$log_tmp"

{
	printf 'eliza-evidence: raw_transcript_end\n'
	printf 'eliza-evidence: exit_code=%s\n' "$status"
	if [ "$status" -eq 0 ]; then
		printf 'eliza-evidence: status=PASS\n'
	else
		printf 'eliza-evidence: status=BLOCKED\n'
	fi
} >>"$log_tmp"
mv "$log_tmp" "$log"

tail -n 80 "$log"

if [ "$status" -ne 0 ]; then
	if [ "${CHIPYARD_LINUX_SMOKE_RETRY_GENERATED:-1}" = "1" ] && [ "$attempt" = "1" ] && \
		grep -Eq 'No rule to make target|fatal error: .*: No such file or directory|(^|/)(mm|VTestDriver)[^[:space:]]*\.d|VTestDriver[^[:space:]]*\.(mk|cpp|h|d)' "$log"; then
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
	printf '  - generated AP run-binary exited with status %s\n' "$status"
	exit 2
fi

cd "$repo_dir"
CHIPYARD_LINUX_BINARY="$binary" python3 scripts/check_chipyard_verilator_linux_smoke.py
