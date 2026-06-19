#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
	echo "usage: $0 /path/to/linux preflight|kernel-build|dtb-check|smoke|ml-smoke" >&2
	exit 2
fi

linux=$1
mode=$2
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../../.." && pwd)
evidence_dir="$repo_root/docs/evidence/linux"
jobs=${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}
cross_compile=${CROSS_COMPILE:-}

for tool_bin in \
	"$repo_root/tools/bin" \
	"$repo_root/external/riscv64-linux-gnu/usr/bin" \
	"$repo_root/external/deb-tools/dtc/usr/bin"; do
	if [ -d "$tool_bin" ]; then
		PATH="$tool_bin:$PATH"
	fi
done
export PATH

if [ ! -f "$linux/Kconfig" ] || [ ! -d "$linux/drivers" ] || [ ! -d "$linux/arch" ]; then
	echo "error: $linux does not look like a Linux kernel checkout" >&2
	exit 1
fi

mkdir -p "$evidence_dir"

repo_status_command="python3 $repo_root/scripts/check_linux_external_bsp.py $linux"

require_imported_bsp() {
	missing=0
	for path in \
		"$linux/drivers/misc/eliza-e1/Kconfig" \
		"$linux/drivers/misc/eliza-e1/Makefile" \
		"$linux/drivers/misc/eliza-e1/eliza-e1-npu.c" \
		"$linux/drivers/misc/eliza-e1/eliza-e1-dma.c" \
		"$linux/drivers/misc/eliza-e1/eliza-e1-display.c" \
		"$linux/drivers/misc/eliza-e1/eliza-e1-gpio.c" \
		"$linux/drivers/misc/eliza-e1/e1_platform_contract.h" \
		"$linux/arch/riscv/boot/dts/eliza/eliza-e1.dts"; do
		if [ ! -f "$path" ]; then
			echo "STATUS: BLOCKED linux.capture-preflight - missing imported BSP file $path" >&2
			missing=1
		fi
	done
	if ! grep -Fqx 'source "drivers/misc/eliza-e1/Kconfig"' "$linux/drivers/misc/Kconfig" 2>/dev/null; then
		echo 'STATUS: BLOCKED linux.capture-preflight - drivers/misc/Kconfig does not source eliza-e1/Kconfig' >&2
		missing=1
	fi
	if ! grep -Fqx 'obj-$'"(CONFIG_ELIZA_E1_BSP)"' += eliza-e1/' "$linux/drivers/misc/Makefile" 2>/dev/null; then
		echo 'STATUS: BLOCKED linux.capture-preflight - drivers/misc/Makefile does not include eliza-e1/' >&2
		missing=1
	fi
	if [ "$missing" -ne 0 ]; then
		echo "next: sw/linux/scripts/import-linux-bsp.sh $linux" >&2
		$repo_status_command >/dev/null || true
		exit 2
	fi
}

require_riscv_compiler() {
	if [ -n "$cross_compile" ]; then
		if ! command -v "${cross_compile}gcc" >/dev/null 2>&1; then
			echo "STATUS: BLOCKED linux.capture-preflight - CROSS_COMPILE compiler not found: ${cross_compile}gcc" >&2
			$repo_status_command >/dev/null || true
			exit 2
		fi
	elif ! command -v riscv64-linux-gnu-gcc >/dev/null 2>&1 && \
		! command -v riscv64-unknown-linux-gnu-gcc >/dev/null 2>&1; then
		echo "STATUS: BLOCKED linux.capture-preflight - set CROSS_COMPILE or install riscv64 Linux compiler" >&2
		$repo_status_command >/dev/null || true
		exit 2
	fi
}

timestamp_utc() {
	date -u '+%Y-%m-%dT%H:%M:%SZ'
}

record_command() {
	artifact=$1
	log=$2
	command=$3
	{
		echo "eliza-evidence: target=linux artifact=$artifact"
		echo "eliza-evidence: status_command=$repo_status_command"
		echo "eliza-evidence: command=$command"
		started=$(timestamp_utc)
		echo "eliza-evidence: started_utc=$started"
		echo "eliza-evidence: linux=$linux"
		echo "eliza-evidence: cross_compile=$cross_compile"
		echo "EXTERNAL_TREE=$linux"
		echo "COMMAND=$command"
		echo "START_UTC=$started"
	} > "$log"
	set +e
	(cd "$linux" && sh -c "$command") >> "$log" 2>&1
	rc=$?
	set -e
	if [ "$rc" -eq 0 ]; then
		if [ "$artifact" = "e1-mmio-smoke" ]; then
			echo "E1_MMIO_SMOKE_PASS" >> "$log"
		elif [ "$artifact" = "e1-npu-ml-smoke" ]; then
			echo "E1_NPU_ML_SMOKE_PASS" >> "$log"
		fi
		echo "eliza-evidence: status=PASS" >> "$log"
		echo "RESULT=PASS" >> "$log"
	else
		echo "eliza-evidence: status=FAIL rc=$rc" >> "$log"
		echo "RESULT=FAIL rc=$rc" >> "$log"
	fi
	ended=$(timestamp_utc)
	echo "eliza-evidence: ended_utc=$ended" >> "$log"
	echo "END_UTC=$ended" >> "$log"
	exit "$rc"
}

make_prefix="make ARCH=riscv"
if [ -n "$cross_compile" ]; then
	make_prefix="$make_prefix CROSS_COMPILE=$cross_compile"
fi
dt_schema_files="Documentation/devicetree/bindings/eliza/eliza,e1-npu.yaml Documentation/devicetree/bindings/eliza/eliza,e1-dma.yaml Documentation/devicetree/bindings/eliza/eliza,e1-display.yaml Documentation/devicetree/bindings/eliza/eliza,e1-gpio.yaml"

case "$mode" in
	preflight)
		$repo_status_command
		;;
	kernel-build)
		require_imported_bsp
		require_riscv_compiler
		record_command \
			eliza_e1_kernel_build \
			"$evidence_dir/eliza_e1_kernel_build.log" \
			"test -f .config && $make_prefix olddefconfig && $make_prefix -j$jobs Image dtbs modules && grep -Eq \"^CONFIG_ELIZA_E1_BSP=\" .config && grep -Eq \"^CONFIG_ELIZA_E1_NPU=\" .config && grep -Eq \"^CONFIG_ELIZA_E1_DMA=\" .config && grep -Eq \"^CONFIG_ELIZA_E1_DISPLAY=\" .config && grep -Fq \"CONFIG_ELIZA_E1_GPIO\" drivers/misc/eliza-e1/Makefile && test -f arch/riscv/boot/Image"
		;;
	dtb-check)
		require_imported_bsp
		record_command \
			eliza_e1_dtb_check \
			"$evidence_dir/eliza_e1_dtb_check.log" \
			"$make_prefix dtbs_check DT_SCHEMA_FILES=\"$dt_schema_files\" && grep -R \"eliza,e1-npu\" arch/riscv/boot/dts/eliza && grep -R \"eliza,e1-dma\" arch/riscv/boot/dts/eliza && grep -R \"eliza,e1-display\" arch/riscv/boot/dts/eliza"
		;;
	smoke)
		if [ -z "${E1_SMOKE_CMD:-}" ]; then
			echo "error: E1_SMOKE_CMD is required, for example: ssh root@TARGET /tmp/e1-mmio-smoke" >&2
			exit 2
		fi
		record_command \
			e1-mmio-smoke \
			"$evidence_dir/e1-mmio-smoke.log" \
			"$E1_SMOKE_CMD"
		;;
	ml-smoke)
		if [ -z "${E1_NPU_ML_SMOKE_CMD:-}" ]; then
			echo "error: E1_NPU_ML_SMOKE_CMD is required, for example: ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu" >&2
			exit 2
		fi
		record_command \
			e1-npu-ml-smoke \
			"$evidence_dir/eliza_e1_npu_ml_smoke.log" \
			"$E1_NPU_ML_SMOKE_CMD"
		;;
	*)
		echo "error: unknown mode $mode" >&2
		exit 2
		;;
esac
