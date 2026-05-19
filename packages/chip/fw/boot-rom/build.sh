#!/usr/bin/env sh
set -eu

repo_dir=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
src="$repo_dir/fw/boot-rom/reset.S"
linker="$repo_dir/fw/boot-rom/linker.ld"
out_dir="$repo_dir/build/boot-rom"
elf="$out_dir/e1_reset_rom.elf"
bin="$out_dir/e1_reset_rom.bin"
hex="$out_dir/e1_reset_rom.hex"

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

    for cc in riscv64-unknown-elf-gcc riscv64-elf-gcc riscv64-linux-gnu-gcc /opt/homebrew/opt/llvm/bin/clang clang; do
        if ! command -v "$cc" >/dev/null 2>&1; then
            continue
        fi
        if [ "$(basename "$cc")" = "clang" ]; then
            set -- "$cc" --target=riscv64-unknown-elf
        else
            set -- "$cc"
        fi
        if "$@" -x assembler -c /dev/null -o "${TMPDIR:-/tmp}/e1-bootrom-toolchain.o" >/dev/null 2>&1; then
            rm -f "${TMPDIR:-/tmp}/e1-bootrom-toolchain.o"
            printf '%s\n' "$cc"
            return 0
        fi
        rm -f "${TMPDIR:-/tmp}/e1-bootrom-toolchain.o"
    done
    return 1
}

find_objcopy() {
    for tool in "${RISCV_OBJCOPY:-}" riscv64-unknown-elf-objcopy riscv64-elf-objcopy /opt/homebrew/opt/llvm/bin/llvm-objcopy llvm-objcopy objcopy; do
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
    status_line "BLOCKED" "bootrom.build" "install llvm-objcopy/riscv64 objcopy or set RISCV_OBJCOPY"
    exit 2
}

mkdir -p "$out_dir"

if [ "$(basename "$cc")" = "clang" ]; then
    set -- "$cc" --target=riscv64-unknown-elf -fuse-ld=lld
else
    set -- "$cc"
fi

"$@" -nostdlib -nostartfiles -ffreestanding \
    -march=rv64ima_zicsr -mabi=lp64 \
    -Wl,-T,"$linker" -Wl,--build-id=none \
    -o "$elf" "$src"

"$objcopy" -O binary "$elf" "$bin"
xxd -p -c 4 "$bin" > "$hex"

status_line "PASS" "bootrom.build" "built ${elf#"$repo_dir"/}, ${bin#"$repo_dir"/}, and ${hex#"$repo_dir"/}"
