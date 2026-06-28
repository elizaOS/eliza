# e1 RVV 1.0 vector integration plan

This document is the honest integration path from the current state — a real
element-wise ALU subset plus functional ISA-level evidence — to a full,
cycle-accurate RVV 1.0 vector backend in the e1 big core. It exists so the
gate in `docs/evidence/cpu_ap/rvv-1-0-execution.yaml` cannot silently flip
green and so reviewers can see exactly what is real today.

## Current state (real)

| Artifact | What it is | Claim level |
|---|---|---|
| `rtl/cpu/rvv/rvv_csr.sv` | The seven RVV CSRs + `vsetvl*` algorithm (V 1.0 §6) | RTL, lint-clean |
| `rtl/cpu/rvv/rvv_alu_subset.sv` | **Real** element-wise int/logic vector ALU: vadd/vsub/vand/vor/vxor/vsll/vsrl/vsra/vmin*/vmax*/vmul/vmv over E8/E16/E32/E64 with vl, vstart prefix, vta tail policy, vill handling | RTL, cocotb-verified |
| `verify/cocotb/cpu/test_rvv_alu_subset.py` | 400 random dispatches checked against a Python reference model, plus vstart/tail/vill cases | passing |
| `rtl/cpu/rvv/rvv_unit_stub.sv` | Dispatch-boundary placeholder for ops outside the subset (returns zeros) | stub, explicitly not a claim |
| `docs/evidence/cpu_ap/e1-rvv-vector.json` | RVV 1.0 functional ISS evidence: scalar-vs-vector dynamic instruction reduction on QEMU `rva23u64`, vlen=256 | **functional** |

The functional evidence is produced by `scripts/run_e1_rvv_vector.sh`, which
builds the autovec kernel suite twice (scalar `rv64gc`, vector `rv64gcv`) with
`riscv-none-elf-gcc 15.2.0`, runs both under QEMU user-mode on an RVV 1.0
substrate, and windows the kernel's dynamic instruction stream with QEMU's
execlog TCG plugin. It establishes that the RVV 1.0 ISA + toolchain path that
e1 targets executes end to end and quantifies the dynamic work the vector ISA
removes — a structural axis CVA6's base core (no vector) cannot match.

### What "functional" does and does not buy

`functional` is the L1 row of `docs/benchmarks/claim-ladder.md`. It can support
ISA correctness and dynamic instruction-count reduction. It **cannot** support
wall-clock latency, throughput, IPC, or any silicon/FPGA performance claim:
QEMU does not model the e1 vector datapath, lane count, or memory timing.

## Gap to a full RTL vector backend

The element-wise ALU is the arithmetic core. A complete RVV 1.0 unit still
needs, in rough dependency order:

1. **Vector LSU path** — unit-stride / strided / indexed (gather-scatter)
   `vle*/vse*/vlse*/vluxei*/vsuxei*`, EMUL/EEW interaction with the L1D, fault
   handling on `vstart`. This is the largest piece and couples to the LSU the
   OoO back-end owns.
2. **Reductions** — `vredsum`, `vfredosum/usum`, `vredmin/max`, with the
   correct ordered/unordered semantics. The functional evidence already shows
   the compiler leans on `vfredosum.vs` heavily.
3. **Mask layer** — mask-producing compares (`vmseq/vmslt/...`), masked
   (`vm=0`) execution of the existing ALU ops, mask logical ops.
4. **Width changes** — widening (`vwadd/vwmul/vwmacc`), narrowing (`vnsrl`),
   and FP/int conversions (`vfcvt/vfwcvt`). The functional histogram shows
   `vwadd.wv`, `vsext.vf2`, `vzext.vf2`, `vfwcvt.f.x.v` are all exercised.
5. **Floating-point datapath** — `vfadd/vfmul/vfmadd/...`, the largest area
   cost; required for the NN kernels (layernorm, gelu, silu, softmax).
6. **Fixed-point** — saturating add/sub, averaging, `vsmul`, `vssra` with
   `vxrm`/`vxsat` (CSRs already present).
7. **Permutation / slides** — `vslideup/down`, `vrgather`, `vcompress`.
8. **Two-datapath big-core config** — the e1-ultra target is 2 × 256-bit
   lanes (512 b/cycle peak); the subset ALU is single-group and must be
   lane-replicated and sequenced.

## Conformance exit criteria

The gate stays fail-closed until:

- the backend (extended subset or a forked open unit — Saturn / Ara / Vicuna
  / XiangShan, per the candidate list in the gate YAML) passes the
  `riscv-arch-test` RVV 1.0 subset and the riscv-dv vector smoke, and
- a cycle-accurate vector kernel run (Verilator on the integrated core)
  produces an L1 number, replacing the functional QEMU figure for any
  performance statement.

## Why not fork a full open vector unit now

Forking Ara or Saturn and elaborating it in Verilator against the e1 CSR /
dispatch contract is a multi-day integration (build systems, Chisel/SV
bridging, LSU coupling) and was out of scope for the turn that produced the
real subset + functional evidence. The subset ALU is the high-confidence,
verifiable down payment: it is real arithmetic, it is tested, and it makes the
"e1 has a vector datapath in RTL" statement true at the element-wise level
without faking the parts that are not yet built.
