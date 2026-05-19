#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
checkout="${CHIPYARD_CHECKOUT:-$repo_dir/external/chipyard}"
sim_dir="$checkout/sims/verilator"
out_dir="$repo_dir/build/chipyard/eliza_rocket"
log="$out_dir/verilator-linux-smoke.log"
config="${CHIPYARD_CONFIG:-ElizaRocketConfig}"
config_package="${CHIPYARD_CONFIG_PACKAGE:-eliza}"
binary="${CHIPYARD_LINUX_BINARY:-}"
timeout_seconds="${CHIPYARD_LINUX_SMOKE_SECONDS:-180}"
use_docker="${CHIPYARD_LINUX_SMOKE_USE_DOCKER:-auto}"
attempt="${CHIPYARD_LINUX_SMOKE_ATTEMPT:-1}"

mkdir -p "$out_dir"

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

cd "$repo_dir"
python3 scripts/check_chipyard_verilator_preflight.py
python3 scripts/check_chipyard_verilator_linux_smoke.py --repair-stale-generated
python3 scripts/check_chipyard_payload_path.py || true

cd "$sim_dir"
# shellcheck disable=SC1091
. ../../env.sh
if [ -z "${RISCV:-}" ] && [ -d "$repo_dir/external/riscv-tools-linux-x64" ]; then
	RISCV="$repo_dir/external/riscv-tools-linux-x64"
	export RISCV
fi
if [ -d "$repo_dir/external/riscv-tools-linux-x64/bin" ]; then
	PATH="$repo_dir/external/riscv-tools-linux-x64/bin:$PATH"
	export PATH
fi

generated_dir="$sim_dir/generated-src/chipyard.harness.TestHarness.$config"
bootrom_src="$checkout/generators/testchipip/src/main/resources/testchipip/bootrom"
mkdir -p "$generated_dir"
for bootrom_img in bootrom.rv64.img bootrom.rv32.img; do
	if [ -f "$bootrom_src/$bootrom_img" ]; then
		cp -f "$bootrom_src/$bootrom_img" "$generated_dir/$bootrom_img"
	fi
done

command_text="make CONFIG=$config CONFIG_PACKAGE=$config_package BINARY=$binary LOADMEM=1 run-binary"
{
	printf 'eliza-evidence: target=generated_chipyard_ap\n'
	printf 'eliza-evidence: wrapper=scripts/run_chipyard_eliza_linux_smoke.sh\n'
	printf 'eliza-evidence: attempt=%s\n' "$attempt"
	printf 'eliza-evidence: command=%s\n' "$command_text"
	printf 'eliza-evidence: payload=%s\n' "$binary"
	printf 'eliza-evidence: timeout_after_seconds=%s\n' "$timeout_seconds"
	printf 'eliza-evidence: note=qemu-virt and Renode reference transcripts do not satisfy this generated AP Linux smoke\n'
	printf 'eliza-evidence: raw_transcript_begin\n'
} >"$log"

set +e
python3 "$repo_dir/scripts/run_with_timeout.py" \
	--timeout-seconds "$timeout_seconds" \
	--label chipyard-generated-ap-linux-smoke \
	-- make CONFIG="$config" CONFIG_PACKAGE="$config_package" BINARY="$binary" LOADMEM=1 run-binary >>"$log" 2>&1
status=$?
set -e

{
	printf 'eliza-evidence: raw_transcript_end\n'
	printf 'eliza-evidence: exit_code=%s\n' "$status"
	if [ "$status" -eq 0 ]; then
		printf 'eliza-evidence: status=PASS\n'
	else
		printf 'eliza-evidence: status=BLOCKED\n'
	fi
} >>"$log"

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
