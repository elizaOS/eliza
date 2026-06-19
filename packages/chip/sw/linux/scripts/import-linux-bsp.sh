#!/usr/bin/env sh
set -eu

check_only=0

if [ "${1:-}" = "--check" ]; then
	check_only=1
	shift
fi

if [ "$#" -ne 1 ]; then
	echo "usage: $0 [--check] /path/to/linux" >&2
	exit 2
fi

linux=$1
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../../.." && pwd)
bsp="$repo_root/sw/linux"
generated="$repo_root/sw/platform/generated"

if [ ! -f "$linux/Kconfig" ] || [ ! -d "$linux/drivers" ] || [ ! -d "$linux/arch" ]; then
	echo "error: $linux does not look like a Linux kernel checkout" >&2
	exit 1
fi

ensure_line() {
	file=$1
	line=$2
	if [ ! -f "$file" ]; then
		echo "error: cannot update missing external file $file" >&2
		exit 1
	fi
	if ! grep -Fqx "$line" "$file"; then
		printf '\n%s\n' "$line" >> "$file"
	fi
}

printf 'Import commands:\n'
printf '  mkdir -p %s/drivers/misc/eliza-e1 %s/arch/riscv/boot/dts/eliza %s/Documentation/devicetree/bindings/eliza %s/kernel/configs\n' "$linux" "$linux" "$linux" "$linux"
printf '  rsync -a %s/drivers/eliza/ %s/drivers/misc/eliza-e1/\n' "$bsp" "$linux"
printf '  cp %s/dts/eliza-e1.dts %s/dts/Makefile %s/arch/riscv/boot/dts/eliza/\n' "$bsp" "$bsp" "$linux"
printf '  cp %s/e1-platform.dtsi %s/arch/riscv/boot/dts/eliza/\n' "$generated" "$linux"
printf '  cp %s/Documentation/devicetree/bindings/eliza/*.yaml %s/Documentation/devicetree/bindings/eliza/\n' "$bsp" "$linux"
printf '  cp %s/e1_platform_contract.h %s/drivers/misc/eliza-e1/e1_platform_contract.h\n' "$generated" "$linux"
printf '  cp %s/configs/eliza_e1.fragment %s/kernel/configs/eliza_e1.config\n' "$bsp" "$linux"
printf 'Then add these fragments in the external Linux tree:\n'
printf '  drivers/misc/Kconfig: source "drivers/misc/eliza-e1/Kconfig"\n'
# shellcheck disable=SC2016
printf '  drivers/misc/Makefile: obj-$(CONFIG_ELIZA_E1_BSP) += eliza-e1/\n'
printf '  arch/riscv/boot/dts/Makefile: subdir-y += eliza\n'
printf 'Capture real evidence back in this repository:\n'
printf '  (cd %s && make ARCH=riscv eliza_e1.config olddefconfig)\n' "$linux"
printf '  python3 %s/scripts/check_linux_external_bsp.py %s\n' "$repo_root" "$linux"
printf '  %s/sw/linux/scripts/capture-linux-bsp-evidence.sh %s kernel-build\n' "$repo_root" "$linux"
printf '  %s/sw/linux/scripts/capture-linux-bsp-evidence.sh %s dtb-check\n' "$repo_root" "$linux"
printf '  E1_SMOKE_CMD='\''ssh root@TARGET /usr/bin/e1-mmio-smoke'\'' %s/sw/linux/scripts/capture-linux-bsp-evidence.sh %s smoke\n' "$repo_root" "$linux"

if [ "$check_only" -eq 0 ]; then
	mkdir -p \
		"$linux/drivers/misc/eliza-e1" \
		"$linux/arch/riscv/boot/dts/eliza" \
		"$linux/Documentation/devicetree/bindings/eliza" \
		"$linux/kernel/configs"
	rsync -a "$bsp/drivers/eliza/" "$linux/drivers/misc/eliza-e1/"
	cp "$bsp/dts/eliza-e1.dts" "$bsp/dts/Makefile" "$linux/arch/riscv/boot/dts/eliza/"
	cp "$generated/e1-platform.dtsi" "$linux/arch/riscv/boot/dts/eliza/"
	cp "$bsp"/Documentation/devicetree/bindings/eliza/*.yaml \
		"$linux/Documentation/devicetree/bindings/eliza/"
	cp "$generated/e1_platform_contract.h" "$linux/drivers/misc/eliza-e1/e1_platform_contract.h"
	cp "$bsp/configs/eliza_e1.fragment" "$linux/kernel/configs/eliza_e1.config"
	ensure_line "$linux/drivers/misc/Kconfig" 'source "drivers/misc/eliza-e1/Kconfig"'
	ensure_line "$linux/drivers/misc/Makefile" 'obj-$'"(CONFIG_ELIZA_E1_BSP)"' += eliza-e1/'
	ensure_line "$linux/arch/riscv/boot/dts/Makefile" 'subdir-y += eliza'
	printf 'Imported Eliza Linux BSP files into the external kernel tree.\n'
fi

if [ "$check_only" -eq 1 ]; then
	missing=0
	for path in \
		"$bsp/drivers/eliza/Kconfig" \
		"$bsp/drivers/eliza/Makefile" \
		"$bsp/drivers/eliza/eliza-e1-npu-uapi.h" \
		"$bsp/drivers/eliza/eliza-e1-npu.c" \
		"$bsp/drivers/eliza/eliza-e1-dma.c" \
		"$bsp/drivers/eliza/eliza-e1-display.c" \
		"$bsp/drivers/eliza/eliza-e1-gpio.c" \
		"$bsp/tests/e1-npu-smoke.c" \
		"$bsp/dts/eliza-e1.dts" \
		"$bsp/dts/Makefile" \
		"$generated/e1-platform.dtsi" \
		"$bsp/configs/eliza_e1.fragment" \
		"$generated/e1_platform_contract.h"; do
		if [ ! -f "$path" ]; then
			echo "FAIL: missing repo artifact ${path#"$repo_root"/}" >&2
			missing=1
		fi
	done
	if ! ls "$bsp"/Documentation/devicetree/bindings/eliza/*.yaml >/dev/null 2>&1; then
		echo "FAIL: missing repo artifact sw/linux/Documentation/devicetree/bindings/eliza/*.yaml" >&2
		missing=1
	fi
	if [ "$missing" -ne 0 ]; then
		exit 1
	fi
	echo "STATUS: PASS linux.import-check - external Linux checkout shape and repo BSP inputs are present"
	echo "STATUS: BLOCKED linux.build-evidence - run scripts/check_linux_external_bsp.py and the external kernel/Image/DTB capture commands"
fi
