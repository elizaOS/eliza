# UFS + DRAM contention scenarios (fio)

This directory holds Intel-Linux-style `fio` job files for measuring
storage bandwidth under DRAM saturation. The phone-class memory gate
accepts <=15% UFS bandwidth degradation when DRAM is saturated by
STREAM Triad.

## Usage

1. Cross-compile `fio` for the RV64 target with the matching Bionic
   sysroot, or use a Debian Riscv64 chroot for bring-up.
2. Mount the test storage at `/data/local/tmp`.
3. Start the DRAM-saturation kernel in one shell:
   `taskset 0xF ./stream`
4. In another shell, run:
   `fio benchmarks/memory/fio/ufs-dram-contention.fio`
5. Capture both processes' stdout; parse with
   `scripts/check_bandwidth_sustained.py --fio-output …`.

## Evidence

The aggregate report belongs at
`docs/evidence/memory/ufs_dram_contention_report.json` with schema
`eliza.memory.ufs_dram_contention.v1`. The phone-class gate requires
UFS read bandwidth degradation <=15% relative to the no-contention
baseline.
