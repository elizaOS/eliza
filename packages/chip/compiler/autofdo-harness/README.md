# AutoFDO profile capture and apply

AutoFDO is sample-based profile-guided optimization. It captures `perf`
(or RISC-V PMU equivalent) samples on a representative workload, converts
to LLVM's sample profile format, and feeds the result back to clang via
`-fprofile-sample-use`.

Measured uplift on similar pipelines:

- AutoFDO alone: ~10.5% geomean on warehouse-scale, ~85% of traditional FDO.
- AutoFDO + Propeller stacked: ~10% throughput uplift in Linux kernel builds.

This harness produces the AutoFDO `.prof` artifact consumed by
[`autofdo-propeller-bolt.md`](../../docs/toolchain/autofdo-propeller-bolt.md).

## Scripts

- `capture.sh` — wraps `perf record` + `create_llvm_prof` to produce a
  sample profile from a workload run.
- `apply.sh` — feeds the profile into a clang rebuild.

## Status

The recipe is committed. End-to-end capture is BLOCKED until:

1. LLVM stage-2 toolchain is built (`scripts/build_llvm_riscv.sh`).
2. A real RISC-V target is available for `perf record` (QEMU virt /
   Verilator / FPGA / silicon).
3. `create_llvm_prof` is installed (LLVM ships it as `llvm-profdata` for
   sample profiles plus the autofdo project at
   https://github.com/google/autofdo).
