# Tier 1 OpenSBI build on macOS: PIE blocker

`brew install riscv64-elf-binutils` ships a linker without `-pie` support
(bare-ELF binutils has no shared-library support and rejects PIE links).
OpenSBI >= v1.5 unconditionally requires `OPENSBI_LD_PIE=y` (see
`external/opensbi/Makefile` line 195 + 212).

OpenSBI v1.4 and older built without PIE, but they don't compile under
GCC 16 (C23 made `bool` a keyword and OpenSBI's `sbi_types.h` typedefs it).

## Workarounds

- **Recommended on macOS**: skip custom OpenSBI build and use the OpenSBI
  bundled with `qemu-system-riscv64` via `-bios default`. This is what
  Tier 2 (`scripts/sim/run_qemu_tier2.sh`) does. Custom S-mode payload
  smoke is not required to validate Linux boot.
- **For custom-platform OpenSBI (Renode / Verilator)**: build inside a
  Linux container or VM with `riscv64-linux-gnu-gcc` + glibc binutils
  that support `-pie`. Recipe:
    docker run --rm -v $PWD:/work -w /work riscv64/ubuntu:24.04 \
      bash -c "apt-get update && apt-get install -y gcc-riscv64-linux-gnu make git && \
               CROSS_COMPILE=riscv64-linux-gnu- bash scripts/build/build_opensbi_qemu.sh"
- **For the eliza platform** specifically, see
  `sw/opensbi/platform/eliza/README.md` (scaffolded on ws/renode-tier2-our-map).
