#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
image="${CHIPYARD_DOCKER_IMAGE:-eliza/chipyard-eliza-minimal-amd64:main-2026-05-20}"
out_dir="$repo_dir/build/chipyard/eliza_rocket"
log="$out_dir/docker-verilog-attempt.log"
platform="${CHIPYARD_DOCKER_PLATFORM:-linux/amd64}"
config="${CHIPYARD_CONFIG:-ElizaRocketConfig}"
config_package="${CHIPYARD_CONFIG_PACKAGE:-eliza}"
java_tool_options="${CHIPYARD_JAVA_TOOL_OPTIONS:--Xmx3G -Xss8M -Djava.io.tmpdir=/work/external/chipyard/.java_tmp}"

mkdir -p "$out_dir"

if ! command -v docker >/dev/null 2>&1; then
	echo "STATUS: BLOCKED chipyard.docker_verilog - docker is not on PATH" | tee "$log"
	exit 1
fi

{
	printf 'eliza-evidence: target=cpu_ap artifact=chipyard_docker_verilog_attempt\n'
	printf 'eliza-evidence: image=%s\n' "$image"
	printf 'eliza-evidence: platform=%s\n' "$platform"
	printf 'eliza-evidence: java_tool_options=%s\n' "$java_tool_options"
	printf 'eliza-evidence: command=make CONFIG=%s CONFIG_PACKAGE=%s verilog\n' "$config" "$config_package"
	printf 'eliza-evidence: raw_transcript_begin\n'
} >"$log"

set +e
docker run --rm --platform "$platform" \
	-v "$repo_dir:/work" \
	-w /work \
	-e "RISCV=/opt/conda/riscv-tools" \
	-e "PATH=/opt/eliza/circt/bin:/opt/conda/riscv-tools/bin:/opt/conda/bin:/opt/conda/condabin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
	-e "JAVA_TOOL_OPTIONS=$java_tool_options" \
	-e "CHIPYARD_JAVA_TOOL_OPTIONS=$java_tool_options" \
	-e "CHIPYARD_DOCKER_IMAGE=$image" \
	-e "CHIPYARD_CONFIG=$config" \
	-e "CHIPYARD_CONFIG_PACKAGE=$config_package" \
	"$image" \
	bash -lc '
		set -e
		echo "container: image=$CHIPYARD_DOCKER_IMAGE"
		echo "container: JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS:-}"
		echo "container: memory_limit_bytes=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo unknown)"
		echo "container: cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
		if [ -f external/chipyard/env.sh ]; then
			source external/chipyard/env.sh
		fi
		export JAVA_TOOL_OPTIONS="${CHIPYARD_JAVA_TOOL_OPTIONS:-$JAVA_TOOL_OPTIONS}"
		echo "container: JAVA_TOOL_OPTIONS_AFTER_ENV=${JAVA_TOOL_OPTIONS:-}"
		python3 scripts/check_chipyard_verilator_preflight.py
		cd external/chipyard/sims/verilator
		anno_dir="generated-src/chipyard.harness.TestHarness.${CHIPYARD_CONFIG}"
		appended_anno="$anno_dir/chipyard.harness.TestHarness.${CHIPYARD_CONFIG}.appended.anno.json"
		extra_anno="$anno_dir/chipyard.harness.TestHarness.${CHIPYARD_CONFIG}.extrafirtool.anno.json"
		if [ -f "$appended_anno" ] && [ ! -s "$appended_anno" ]; then
			echo "container: removing zero-length generated annotation $appended_anno"
			rm -f "$appended_anno" "$extra_anno"
		fi
		make CONFIG="$CHIPYARD_CONFIG" CONFIG_PACKAGE="$CHIPYARD_CONFIG_PACKAGE" verilog
	' >>"$log" 2>&1
rc=$?
set -e

{
	printf 'eliza-evidence: raw_transcript_end\n'
	printf 'eliza-evidence: exit_code=%s\n' "$rc"
	if [ "$rc" -eq 0 ]; then
		printf 'eliza-evidence: status=PASS\n'
		echo "STATUS: PASS chipyard.docker_verilog - generated Verilog command completed"
	else
		printf 'eliza-evidence: status=BLOCKED\n'
		echo "STATUS: BLOCKED chipyard.docker_verilog - containerized Verilog generation did not complete"
	fi
	printf 'REPORT: %s\n' "${log#"$repo_dir"/}"
} | tee -a "$log"

exit "$rc"
