#!/usr/bin/env sh
# Build the E1X bare-metal repair-ROM programming boot image.
#
# Links reset.S + boot_repair_main.c + the freestanding boot core into an ELF,
# then emits a flat binary and a 32-bit-word hex image. Fails closed with a
# STATUS line if no RISC-V ELF toolchain is on PATH (set RISCV_CC / RISCV_OBJCOPY
# to override discovery).
set -eu

repo_dir=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
fw_dir="$repo_dir/fw/e1x"
out_dir="$repo_dir/build/e1x-boot-repair-fw"
elf="$out_dir/e1x_boot_repair.elf"
bin="$out_dir/e1x_boot_repair.bin"
hex="$out_dir/e1x_boot_repair.hex"

srcs="$fw_dir/reset.S $fw_dir/boot_repair_main.c $fw_dir/e1x_repair_boot.c"

status_line() {
    printf 'STATUS: %s %s - %s\n' "$1" "$2" "$3"
}

find_cc() {
    if [ -n "${RISCV_CC:-}" ] && command -v "$RISCV_CC" >/dev/null 2>&1; then
        printf '%s\n' "$RISCV_CC"
        return 0
    fi
    for cc in riscv64-unknown-elf-gcc riscv64-elf-gcc riscv-none-elf-gcc riscv64-linux-gnu-gcc; do
        if command -v "$cc" >/dev/null 2>&1; then
            printf '%s\n' "$cc"
            return 0
        fi
    done
    return 1
}

find_objcopy() {
    for tool in "${RISCV_OBJCOPY:-}" riscv64-unknown-elf-objcopy riscv64-elf-objcopy riscv-none-elf-objcopy llvm-objcopy objcopy; do
        if [ -n "$tool" ] && command -v "$tool" >/dev/null 2>&1; then
            printf '%s\n' "$tool"
            return 0
        fi
    done
    return 1
}

cc=$(find_cc) || {
    status_line "BLOCKED" "e1x-boot-repair-fw.build" "install a RISC-V ELF compiler or set RISCV_CC"
    exit 2
}
objcopy=$(find_objcopy) || {
    status_line "BLOCKED" "e1x-boot-repair-fw.build" "install riscv64 objcopy or set RISCV_OBJCOPY"
    exit 2
}

mkdir -p "$out_dir"

# shellcheck disable=SC2086
"$cc" -nostdlib -nostartfiles -ffreestanding -fno-builtin -fno-pic \
    -fdata-sections -ffunction-sections \
    -march=rv64imac_zicsr -mabi=lp64 -mcmodel=medany -O2 -Wall -Wextra \
    -I"$fw_dir" \
    -Wl,-T,"$fw_dir/linker.ld" -Wl,--gc-sections -Wl,--build-id=none \
    -Wl,--no-warn-rwx-segments \
    -o "$elf" $srcs

"$objcopy" -O binary "$elf" "$bin"
python3 -c "import pathlib; data=pathlib.Path('$bin').read_bytes(); \
words=[int.from_bytes(data[i:i+4].ljust(4, b'\\x00'),'little') for i in range(0,len(data),4)]; \
pathlib.Path('$hex').write_text('\\n'.join(f'{w:08x}' for w in words)+'\\n')"

status_line "PASS" "e1x-boot-repair-fw.build" "built ${elf#"$repo_dir"/}, ${bin#"$repo_dir"/}, and ${hex#"$repo_dir"/}"
