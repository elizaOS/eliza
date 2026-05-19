#!/usr/bin/env bash
# Canonical probe for RISC-V 64 cross toolchains and QEMU on the host.
# Prints which toolchains are present, their versions, and whether they
# are sufficient for bare-metal (OpenSBI, U-Boot SPL, kernel-only) or
# full Linux userspace (glibc) builds.
#
# Exit code:
#   0 - at least one RV64 cc and qemu-system-riscv64 are present
#   1 - missing qemu-system-riscv64 or no RV64 cc at all
set -u

found_cc=""
found_qemu=""
have_glibc=0
have_elf=0

print_ver() {
  local bin="$1"
  if command -v "$bin" >/dev/null 2>&1; then
    printf "  [OK]   %-40s -> %s\n" "$bin" "$(command -v "$bin")"
    "$bin" --version 2>/dev/null | head -1 | sed 's/^/         /'
    return 0
  else
    printf "  [MISS] %s\n" "$bin"
    return 1
  fi
}

echo "== RISC-V 64 cross compilers =="
for cc in riscv64-linux-gnu-gcc riscv64-unknown-linux-gnu-gcc; do
  if print_ver "$cc"; then
    have_glibc=1
    found_cc="${found_cc:-$cc}"
  fi
done
for cc in riscv64-elf-gcc riscv64-unknown-elf-gcc; do
  if print_ver "$cc"; then
    have_elf=1
    found_cc="${found_cc:-$cc}"
  fi
done

echo
echo "== QEMU =="
if print_ver qemu-system-riscv64; then
  found_qemu="qemu-system-riscv64"
fi

echo
echo "== Capability summary =="
if [[ $have_glibc -eq 1 ]]; then
  echo "  glibc cross  : YES -> can build full Linux userspace (busybox-glibc, init)"
else
  echo "  glibc cross  : NO  -> cannot link against glibc on host"
fi
if [[ $have_elf -eq 1 ]]; then
  echo "  bare-metal   : YES -> can build OpenSBI, U-Boot SPL, freestanding kernel objects"
else
  echo "  bare-metal   : NO"
fi
if [[ -n "$found_qemu" ]]; then
  echo "  qemu rv64    : YES -> can run virt/sifive_u boards"
else
  echo "  qemu rv64    : NO"
fi

echo
if [[ -z "$found_cc" || -z "$found_qemu" ]]; then
  echo "RESULT: incomplete toolchain. See docs/toolchain/riscv64-cross-host.md"
  exit 1
fi

if [[ $have_glibc -eq 0 ]]; then
  echo "RESULT: bare-metal-only. Sufficient for OpenSBI + freestanding kernel."
  echo "        For glibc userspace, build inside a Linux container or use buildroot/yocto."
else
  echo "RESULT: full toolchain available."
fi
exit 0
