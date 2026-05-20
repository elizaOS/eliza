#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
image="${CHIPYARD_DOCKER_IMAGE:-eliza/chipyard-eliza-minimal-amd64:main-2026-05-20}"
platform="${CHIPYARD_DOCKER_PLATFORM:-linux/amd64}"
out_dir="$repo_dir/build/chipyard/eliza_rocket"
log="$out_dir/verilator-linux-smoke.log"
runner_log="$out_dir/verilator-linux-smoke-runner.log"
config="${CHIPYARD_CONFIG:-ElizaRocketConfig}"
config_package="${CHIPYARD_CONFIG_PACKAGE:-eliza}"
payload="${CHIPYARD_LINUX_BINARY:-$repo_dir/external/chipyard/software/firemarshal/images/firechip/linux-poweroff/linux-poweroff-bin-nodisk}"
payload_container="/work/${payload#"$repo_dir"/}"
binary_arg="${CHIPYARD_LINUX_SMOKE_BINARY_ARG:-$payload_container}"
jobs="${CHIPYARD_LINUX_SMOKE_JOBS:-1}"
timeout_seconds="${CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS:-1200}"
timeout_cycles="${CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES:-50000000}"
extra_sim_flags="${CHIPYARD_LINUX_SMOKE_EXTRA_SIM_FLAGS:-+custom_boot_pin=1 +uart_tx_printf=1}"
run_target="${CHIPYARD_LINUX_SMOKE_RUN_TARGET:-run-binary-fast}"
loadmem="${CHIPYARD_LINUX_SMOKE_LOADMEM:-1}"
clean="${CHIPYARD_LINUX_SMOKE_CLEAN:-0}"
attempt="${CHIPYARD_LINUX_SMOKE_ATTEMPT:-1}"
retry_generated="${CHIPYARD_LINUX_SMOKE_RETRY_GENERATED:-1}"

mkdir -p "$out_dir"

if ! command -v docker >/dev/null 2>&1; then
	echo "STATUS: BLOCKED chipyard.verilator_linux_smoke_docker - docker is not on PATH" | tee "$runner_log"
	exit 2
fi
if [ ! -f "$payload" ]; then
	echo "STATUS: BLOCKED chipyard.verilator_linux_smoke_docker - payload missing: ${payload#"$repo_dir"/}" | tee "$runner_log"
	exit 2
fi

{
	printf 'eliza-evidence: target=cpu_ap artifact=chipyard_verilator_linux_smoke\n'
	printf 'eliza-evidence: image=%s\n' "$image"
	printf 'eliza-evidence: platform=%s\n' "$platform"
	printf 'eliza-evidence: config=%s\n' "$config"
	printf 'eliza-evidence: config_package=%s\n' "$config_package"
	printf 'eliza-evidence: attempt=%s\n' "$attempt"
	printf 'eliza-evidence: clean_generated=%s\n' "$clean"
	printf 'eliza-evidence: payload=%s\n' "$payload_container"
	printf 'eliza-evidence: binary_arg=%s\n' "$binary_arg"
	printf 'eliza-evidence: timeout_seconds=%s\n' "$timeout_seconds"
	printf 'eliza-evidence: timeout_cycles=%s\n' "$timeout_cycles"
	printf 'eliza-evidence: run_target=%s\n' "$run_target"
	printf 'eliza-evidence: raw_transcript_begin\n'
} >"$log"

set +e
docker run --rm --platform "$platform" \
	-v "$repo_dir:/work" \
	-w /work \
	--entrypoint /bin/bash \
	-e "CHIPYARD_CONFIG=$config" \
	-e "CHIPYARD_CONFIG_PACKAGE=$config_package" \
	-e "CHIPYARD_LINUX_BINARY=$payload_container" \
	-e "CHIPYARD_LINUX_SMOKE_BINARY_ARG=$binary_arg" \
	-e "CHIPYARD_LINUX_SMOKE_CLEAN=$clean" \
	-e "CHIPYARD_LINUX_SMOKE_LOADMEM=$loadmem" \
	-e "CHIPYARD_LINUX_SMOKE_JOBS=$jobs" \
	-e "CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS=$timeout_seconds" \
	-e "CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES=$timeout_cycles" \
	-e "CHIPYARD_LINUX_SMOKE_EXTRA_SIM_FLAGS=$extra_sim_flags" \
	-e "ELIZA_HOST_REPO_DIR=$repo_dir" \
	-e "CHIPYARD_LINUX_SMOKE_RUN_TARGET=$run_target" \
	"$image" -lc '
		set -e
		export PATH=/work/external/oss-cad-suite-linux-x64/bin:/work/external/chipyard/.circt/bin:/work/external/riscv-tools-linux-x64/bin:/opt/conda/bin:/opt/conda/condabin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
		export RISCV=/work/external/riscv-tools-linux-x64
		export CPATH=$RISCV/include${CPATH:+:$CPATH}
		export LIBRARY_PATH=$RISCV/lib${LIBRARY_PATH:+:$LIBRARY_PATH}
		export LD_LIBRARY_PATH=$RISCV/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
		export VERILATOR_ROOT=/work/external/oss-cad-suite-linux-x64/share/verilator
		if [ -f external/chipyard/env.sh ]; then
			source external/chipyard/env.sh
		fi
		export PATH=/work/external/oss-cad-suite-linux-x64/bin:/work/external/chipyard/.circt/bin:/work/external/riscv-tools-linux-x64/bin:$PATH
		export RISCV=/work/external/riscv-tools-linux-x64
		export CPATH=$RISCV/include${CPATH:+:$CPATH}
		export LIBRARY_PATH=$RISCV/lib${LIBRARY_PATH:+:$LIBRARY_PATH}
		export LD_LIBRARY_PATH=$RISCV/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
		export VERILATOR_ROOT=/work/external/oss-cad-suite-linux-x64/share/verilator
		if [ ! -f "$RISCV/include/fesvr/memif.h" ]; then
			echo "STATUS: BLOCKED chipyard.verilator_linux_smoke_docker - RISCV lacks FESVR headers: $RISCV"
			exit 2
		fi
		python3 /work/scripts/repair_chipyard_generated_paths.py --rewrite \
			--stale-root "$ELIZA_HOST_REPO_DIR" \
			--replacement-root /work || true
		cd external/chipyard/sims/verilator
			if [ "$CHIPYARD_LINUX_SMOKE_CLEAN" = "1" ]; then
				python3 - "$CHIPYARD_CONFIG" <<-PY
			import os
			import pathlib
			import shutil
			import stat
			import sys

				config = sys.argv[1]
				path = pathlib.Path(
				    f"generated-src/chipyard.harness.TestHarness.{config}"
				)

			def onexc(function, path_value, exc_info):
			    try:
			        os.chmod(path_value, stat.S_IRWXU)
			        function(path_value)
			    except FileNotFoundError:
			        pass

			if path.exists():
			    shutil.rmtree(path, onerror=onexc)
				PY
				rm -f "simulator-chipyard.harness-$CHIPYARD_CONFIG"
			fi
			generated_dir="/work/external/chipyard/sims/verilator/generated-src/chipyard.harness.TestHarness.$CHIPYARD_CONFIG"
			bootrom_src="/work/external/chipyard/generators/testchipip/src/main/resources/testchipip/bootrom"
			mkdir -p "$generated_dir"
			for bootrom_img in bootrom.rv64.img bootrom.rv32.img; do
				if [ -f "$bootrom_src/$bootrom_img" ]; then
					cp -f "$bootrom_src/$bootrom_img" "$generated_dir/$bootrom_img"
					echo "eliza-evidence: seeded_bootrom=$generated_dir/$bootrom_img"
				fi
			done
			if [ ! -f "$generated_dir/bootrom.rv64.img" ]; then
				echo "STATUS: BLOCKED chipyard.verilator_linux_smoke_docker - missing seeded bootrom: $generated_dir/bootrom.rv64.img"
				exit 2
			fi
			model_mk="/work/external/chipyard/sims/verilator/generated-src/chipyard.harness.TestHarness.$CHIPYARD_CONFIG/chipyard.harness.TestHarness.$CHIPYARD_CONFIG/VTestDriver.mk"
		simulator="/work/external/chipyard/sims/verilator/simulator-chipyard.harness-$CHIPYARD_CONFIG"
		model_dir="$(dirname "$model_mk")"
		if [ -d "$model_dir" ] && find "$model_dir" -maxdepth 1 -name "VTestDriver*.o" -size 0c -print -quit | grep -q .; then
			find "$model_dir" -maxdepth 1 -name "VTestDriver*.o" -size 0c -delete
			rm -f "$model_dir"/VTestDriver__ALL.a "$model_dir"/VTestDriver__ALL.verilator_deplist.tmp
		fi
		make -j "$CHIPYARD_LINUX_SMOKE_JOBS" CONFIG="$CHIPYARD_CONFIG" CONFIG_PACKAGE="$CHIPYARD_CONFIG_PACKAGE" \
			RISCV=/work/external/riscv-tools-linux-x64 \
			AR=x86_64-conda-linux-gnu-ar LRISCV= \
			DISABLE_DRAMSIM=1 \
			SIM_OPT_CXXFLAGS="-O0 -g0" \
			VERILATOR_OPT_FLAGS="-O0 --x-assign fast --x-initial fast --output-split 2000 --output-split-cfuncs 50" \
			EXTRA_SIM_CXXFLAGS="-O0 -g0 -I/work/external/riscv-tools-linux-x64/include" \
			EXTRA_SIM_LDFLAGS="-L/work/external/riscv-tools-linux-x64/lib -Wl,-rpath,/work/external/riscv-tools-linux-x64/lib" \
			"$simulator"
		case "$CHIPYARD_LINUX_SMOKE_RUN_TARGET" in
			run-binary|run-binary-fast) ;;
			*) echo "STATUS: BLOCKED chipyard.verilator_linux_smoke_docker - unsupported run target: $CHIPYARD_LINUX_SMOKE_RUN_TARGET"; exit 2 ;;
		esac
		run_binary_cmd="make -j \"$CHIPYARD_LINUX_SMOKE_JOBS\" CONFIG=\"$CHIPYARD_CONFIG\" CONFIG_PACKAGE=\"$CHIPYARD_CONFIG_PACKAGE\" RISCV=/work/external/riscv-tools-linux-x64 AR=x86_64-conda-linux-gnu-ar LRISCV= DISABLE_DRAMSIM=1 BREAK_SIM_PREREQ=1 TIMEOUT_CYCLES=\"$CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES\" EXTRA_SIM_CXXFLAGS=\"-O0 -g0 -I/work/external/riscv-tools-linux-x64/include\" EXTRA_SIM_LDFLAGS=\"-L/work/external/riscv-tools-linux-x64/lib -Wl,-rpath,/work/external/riscv-tools-linux-x64/lib\" EXTRA_SIM_FLAGS=\"$CHIPYARD_LINUX_SMOKE_EXTRA_SIM_FLAGS\""
		if [ "$CHIPYARD_LINUX_SMOKE_LOADMEM" = "1" ]; then
			run_binary_cmd="$run_binary_cmd BINARY=\"$CHIPYARD_LINUX_SMOKE_BINARY_ARG\" LOADMEM=1"
		elif [ -n "$CHIPYARD_LINUX_SMOKE_LOADMEM" ]; then
			run_binary_cmd="$run_binary_cmd BINARY=\"$CHIPYARD_LINUX_SMOKE_BINARY_ARG\" LOADMEM=\"$CHIPYARD_LINUX_SMOKE_LOADMEM\""
		else
			run_binary_cmd="$run_binary_cmd BINARY=\"$CHIPYARD_LINUX_SMOKE_BINARY_ARG\""
		fi
		run_binary_cmd="$run_binary_cmd \"$CHIPYARD_LINUX_SMOKE_RUN_TARGET\""
		echo "eliza-evidence: command=$run_binary_cmd"
		python3 - "$CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS" "$run_binary_cmd" <<PY
import os, signal, subprocess, sys
timeout = int(sys.argv[1])
command = sys.argv[2]
proc = subprocess.Popen(["bash", "-lc", command], start_new_session=True)
try:
    raise SystemExit(proc.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    print(f"eliza-evidence: timeout_after_seconds={timeout}", flush=True)
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    raise SystemExit(124)
PY
	' >>"$log" 2>&1
status_code=$?
set -e

{
	printf 'eliza-evidence: raw_transcript_end\n'
	printf 'eliza-evidence: exit_code=%s\n' "$status_code"
	if [ "$status_code" -eq 0 ]; then
		printf 'eliza-evidence: status=PASS\n'
	else
		printf 'eliza-evidence: status=BLOCKED\n'
	fi
} >>"$log"

if [ "$status_code" -ne 0 ] && [ "$retry_generated" = "1" ] && [ "$attempt" = "1" ] && \
	grep -Eq 'No rule to make target|fatal error: .*: No such file or directory|(^|/)(mm|VTestDriver)[^[:space:]]*\.d|VTestDriver[^[:space:]]*\.(mk|cpp|h|d)' "$log"; then
	attempt_log="$out_dir/verilator-linux-smoke.attempt1.log"
	cp "$log" "$attempt_log"
	printf 'STATUS: REPAIR chipyard.verilator_linux_smoke_docker\n'
	printf '  reason: generated Verilator model artifact failure in %s\n' "${attempt_log#"$repo_dir"/}"
	printf '  action: retry once after cleaning only generated Chipyard simulator outputs\n'
	CHIPYARD_LINUX_SMOKE_ATTEMPT=2 \
	CHIPYARD_LINUX_SMOKE_RETRY_GENERATED=0 \
	CHIPYARD_LINUX_SMOKE_CLEAN=1 \
	exec "$repo_dir/scripts/run_chipyard_eliza_linux_smoke_docker.sh"
fi

cp "$log" "$runner_log"
tail -n 120 "$log"

if [ "$status_code" -ne 0 ]; then
	CHIPYARD_LINUX_BINARY="$payload" CHIPYARD_ALLOW_CONTAINER_GENERATED_PATHS=1 python3 "$repo_dir/scripts/check_chipyard_verilator_linux_smoke.py" >/dev/null 2>&1 || true
	printf 'STATUS: BLOCKED chipyard.verilator_linux_smoke_docker\n'
	printf '  log: %s\n' "${log#"$repo_dir"/}"
	printf '  next_command: CHIPYARD_LINUX_SMOKE_USE_DOCKER=1 CHIPYARD_LINUX_SMOKE_CLEAN=1 %s\n' "${0#"$repo_dir"/}"
	exit 2
fi

CHIPYARD_LINUX_BINARY="$payload" CHIPYARD_ALLOW_CONTAINER_GENERATED_PATHS=1 python3 "$repo_dir/scripts/check_chipyard_verilator_linux_smoke.py"
