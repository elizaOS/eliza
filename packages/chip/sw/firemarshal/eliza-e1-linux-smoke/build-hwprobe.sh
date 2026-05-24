#!/bin/sh
set -eu

find_cc() {
	if [ "${RISCV64_LINUX_GCC:-}" ]; then
		printf '%s\n' "$RISCV64_LINUX_GCC"
		return 0
	fi
	for cc in \
		riscv64-unknown-linux-gnu-gcc \
		riscv64-linux-gnu-gcc \
		../../../external/chipyard/software/firemarshal/boards/default/distros/br/buildroot/output/host/bin/riscv64-unknown-linux-gnu-gcc
	do
		if command -v "$cc" >/dev/null 2>&1; then
			command -v "$cc"
			return 0
		fi
		if [ -x "$cc" ]; then
			printf '%s\n' "$cc"
			return 0
		fi
	done
	return 1
}

script_dir="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/../../.." && pwd)"
cd "$script_dir"

cc="$(find_cc)" || {
	echo "missing RV64 Linux cross compiler for eliza-riscv-hwprobe" >&2
	exit 1
}

"$cc" -static -O2 -Wall -Wextra -o eliza-riscv-hwprobe eliza-riscv-hwprobe.c
"$cc" -static -O2 -Wall -Wextra \
	-I"$repo_root/sw/linux/drivers/e1" \
	-o e1-npu-ml-smoke \
	"$repo_root/sw/buildroot/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c"
