# AutoFDO + Propeller + BOLT stack for the e1 Android system image

Stacked AutoFDO + Propeller + BOLT realistically delivers 12-18% on a
system image (10% AutoFDO+Propeller, 2-6% BOLT, ~2% Machine Function
Splitter). Linux 6.19 RISC-V Spectre mitigations cost 5-10% in tight loops,
so the net win for security-on builds is ~5-10%.

## Pipeline

```
                        +-------------------+
  representative load   |  perf record      |
  on QEMU/Verilator/FPGA| (cycles + br LBR) |
                        +---------+---------+
                                  | sample data
                                  v
                        +-------------------+
                        | create_llvm_prof  |
                        | or llvm-profgen   |
                        +---------+---------+
                                  | autofdo.prof
                                  v
                        +--------------------------------+
                        | clang -fprofile-sample-use=... |
                        | -fbasic-block-sections=labels  |
                        +---------+----------------------+
                                  | objects with section labels
                                  v
                        +-------------------+
                        | lld + Propeller   |
                        | symbol-ordering   |
                        +---------+---------+
                                  | linked elf
                                  v
                        +-------------------+
                        | llvm-bolt         |
                        | --instrument      |
                        +---------+---------+
                                  | profile from instrumented run
                                  v
                        +--------------------------------+
                        | llvm-bolt --reorder-blocks=    |
                        |    ext-tsp --hfsort+ --split   |
                        +---------+----------------------+
                                  | optimized elf  <-- final
                                  v
```

## Harnesses

| Stage | Script | Status |
| --- | --- | --- |
| AutoFDO capture | [`compiler/autofdo-harness/capture.sh`](../../compiler/autofdo-harness/capture.sh) | recipe committed; BLOCKED on `perf` + LLVM stage 2 |
| AutoFDO apply | [`compiler/autofdo-harness/apply.sh`](../../compiler/autofdo-harness/apply.sh) | recipe committed; BLOCKED on LLVM stage 2 |
| Propeller relink | [`compiler/propeller-harness/relink.sh`](../../compiler/propeller-harness/relink.sh) | recipe committed; BLOCKED on lld stage 2 |
| BOLT optimize | [`compiler/bolt-harness/optimize.sh`](../../compiler/bolt-harness/optimize.sh) | recipe committed; BLOCKED on llvm-bolt stage 2 |

## Default flags applied throughout

```sh
# Build with BB section labels so Propeller / BOLT can reorder.
clang -O3 -flto=thin -fvectorize \
      --target=riscv64-unknown-linux-gnu \
      -march=rva23u64 -mcpu=eliza-e1 -mtune=eliza-e1 \
      -fbasic-block-sections=labels \
      -fcf-protection=full -fstack-clash-protection -fstack-protector-strong \
      -fprofile-sample-use=<autofdo.prof>

# Relink with Propeller layout.
ld.lld --symbol-ordering-file=<propeller-order.txt> --no-keep-text-section-prefix

# BOLT instrumented + optimized.
llvm-bolt --instrument --instrumentation-file-append-pid in.elf -o instrumented.elf
# ... run workload, capture /tmp/prof.fdata ...
llvm-bolt in.elf --data /tmp/prof.fdata.* \
   --reorder-blocks=ext-tsp --reorder-functions=hfsort+ \
   --split-functions --split-all-cold --use-gnu-stack --dyno-stats \
   -o out.elf
```

## Machine Function Splitter

`-fbasic-block-sections=list=<list>` plus `-fsplit-machine-functions` (in
LLVM trunk) split cold blocks into a separate section. Measured benefits:
2.33% runtime, 32% iTLB miss reduction, 9.5% L1 iCache miss reduction.
This complements Propeller; both should be on for the system image.

## Linux kernel uplift target

Standard in Linux 6.19+: 5-10% kernel uplift from AutoFDO + Propeller.

## Evidence gate

[`docs/evidence/compiler/autofdo-evidence.yaml`](../evidence/compiler/autofdo-evidence.yaml).
The gate is BLOCKED on:

1. Stage-2 LLVM built (`make llvm-build`).
2. CoreMark or equivalent micro-benchmark running on a RISC-V target with
   `perf record` available.
3. Demonstrated PGO roundtrip with a >= 5% uplift on the chosen benchmark
   (after Spectre mitigations).
