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
linux_src="$repo_root/external/chipyard/software/firemarshal/boards/default/linux"
opensbi_src="$repo_root/external/chipyard/software/firemarshal/boards/default/firmware/opensbi"
linux_e1_src="$repo_root/sw/linux/drivers/e1"
linux_e1_dst="$linux_src/drivers/misc/eliza-e1"
cd "$script_dir"

if ! grep -q "eliza_skip_unaligned_probe" "$linux_src/arch/riscv/kernel/cpufeature.c"; then
	patch -d "$linux_src" -p1 < "$script_dir/eliza-skip-unaligned-probe.patch"
fi
if ! awk '
	/static int generic_final_init\(bool cold_boot\)/ { in_fn = 1 }
	in_fn && /return 0;/ { found = 1 }
	in_fn && /if \(cold_boot\)/ { exit !found }
' "$opensbi_src/platform/generic/platform.c"; then
	patch -d "$opensbi_src" -N -p1 < "$script_dir/opensbi-eliza-platform-fast-final.patch"
fi
cp -f "$script_dir/opensbi-eliza_defconfig" "$opensbi_src/platform/generic/configs/eliza_defconfig"

mkdir -p "$linux_e1_dst"
cp -f \
	"$linux_e1_src/Kconfig" \
	"$linux_e1_src/Makefile" \
	"$linux_e1_src/e1-dma.c" \
	"$linux_e1_src/e1-npu.c" \
	"$linux_e1_src/e1-npu-uapi.h" \
	"$linux_e1_src/e1_platform_contract.h" \
	"$linux_e1_dst/"
if ! grep -q 'source "drivers/misc/eliza-e1/Kconfig"' "$linux_src/drivers/misc/Kconfig"; then
	python3 - "$linux_src/drivers/misc/Kconfig" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
needle = 'menu "Misc devices"\n'
insert = 'source "drivers/misc/eliza-e1/Kconfig"\n\n'
if insert not in text:
    text = text.replace(needle, needle + "\n" + insert, 1)
path.write_text(text)
PY
fi
# $(CONFIG_ELIZA_E1_BSP) is a Makefile variable — single quotes prevent premature shell expansion
# shellcheck disable=SC2016
if ! grep -q 'obj-$(CONFIG_ELIZA_E1_BSP).*eliza-e1/' "$linux_src/drivers/misc/Makefile"; then
	printf '\nobj-$(CONFIG_ELIZA_E1_BSP)\t+= eliza-e1/\n' >> "$linux_src/drivers/misc/Makefile"
fi

cc="$(find_cc)" || {
	echo "missing RV64 Linux cross compiler for eliza-riscv-hwprobe" >&2
	exit 1
}

"$cc" -static -O2 -Wall -Wextra -o eliza-riscv-hwprobe eliza-riscv-hwprobe.c
"$cc" -static -O2 -Wall -Wextra \
	-I"$repo_root/sw/linux/drivers/e1" \
	-o e1-npu-ml-smoke \
	"$repo_root/sw/buildroot/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c"
