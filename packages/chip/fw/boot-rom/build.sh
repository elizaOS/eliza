#!/usr/bin/env sh
set -eu

repo_dir=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
rom_dir="$repo_dir/fw/boot-rom"
secure_dir="$rom_dir/secure"
linker="$secure_dir/rom.ld"
out_dir="$repo_dir/build/boot-rom"
elf="$out_dir/e1_secure_boot_rom.elf"
bin="$out_dir/e1_secure_boot_rom.bin"
hex="$out_dir/e1_secure_boot_rom.hex"

for tool_dir in \
    "$repo_dir/tools/bin" \
    "$repo_dir/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin" \
    "$repo_dir/external/riscv64-linux-gnu/usr/bin"
do
    if [ -d "$tool_dir" ]; then
        PATH="$tool_dir:$PATH"
    fi
done
export PATH

# Sources: the C reset entrypoint (reset.S) plus the full secure-boot ROM:
# OPNPHN01 verifier, freestanding Ed25519 + SHA-256, measurement chain, and
# freestanding memory primitives. reset.S calls into boot.c, which decides the
# authenticated handoff target (fail-closed trap on reject).
srcs="$rom_dir/reset.S \
$secure_dir/rom_libc.c \
$secure_dir/sha256.c \
$secure_dir/ed25519_ct.c \
$secure_dir/verify.c \
$secure_dir/measure.c \
$secure_dir/boot.c"

status_line() {
    state=$1
    check=$2
    detail=$3
    printf 'STATUS: %s %s - %s\n' "$state" "$check" "$detail"
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
    status_line "BLOCKED" "bootrom.build" "install a RISC-V ELF compiler or set RISCV_CC"
    exit 2
}
objcopy=$(find_objcopy) || {
    status_line "BLOCKED" "bootrom.build" "install riscv64 objcopy or set RISCV_OBJCOPY"
    exit 2
}

mkdir -p "$out_dir"

# shellcheck disable=SC2086
"$cc" -nostdlib -nostartfiles -ffreestanding -fno-builtin -fno-pic \
    -fdata-sections -ffunction-sections \
    -march=rv64imac_zicsr -mabi=lp64 -mcmodel=medany -Os \
    -I"$secure_dir" \
    -Wl,-T,"$linker" -Wl,--no-relax -Wl,--gc-sections -Wl,--build-id=none \
    -o "$elf" $srcs -lgcc

"$objcopy" -O binary "$elf" "$bin"
python3 -c "import pathlib; data=pathlib.Path('$bin').read_bytes(); \
words=[int.from_bytes(data[i:i+4].ljust(4, b'\\x00'),'little') for i in range(0,len(data),4)]; \
pathlib.Path('$hex').write_text('\\n'.join(f'{w:08x}' for w in words)+'\\n')"

status_line "PASS" "bootrom.build" "built ${elf#"$repo_dir"/}, ${bin#"$repo_dir"/}, and ${hex#"$repo_dir"/}"
