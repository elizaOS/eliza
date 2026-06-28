# e1 RVV 1.0 + Ztso + Sv57 + Zicfilp/Zicfiss contract

This document binds the OoO agent's RTL (`rtl/cpu/rvv/`, `rtl/cpu/csr/`),
the evidence gates (`docs/evidence/cpu_ap/rvv-1-0-execution.yaml`,
`csr-trap-evidence.yaml`, `mmu-sv39-evidence.yaml`), and the
RVA23-profile plan at `docs/evidence/cpu-ap-rva23-profile-plan.json`.

## RVV 1.0 (V extension, ratified 2021)

Specification: [RISC-V "V" Vector Extension 1.0 ratified](https://github.com/riscvarchive/riscv-v-spec).

### Per-role parameter contract

| Role | VLEN (bits) | DLEN (bits) | ELEN (bits) | Datapaths | Vector regs | Extra subset |
|---|---|---|---|---|---|---|
| e1-ultra | 256 | 256 | 64 | 2 | 32 × 256b | Zvbb, Zvfh, Zvkt, Zvqdotq (planned) |
| e1-premium | 128 | 128 | 64 | 1 | 32 × 128b | Zvbb |
| e1-pro | n/a | n/a | n/a | 0 | n/a | none (vector instructions trap) |

### CSR file

Implemented in `rtl/cpu/rvv/rvv_csr.sv`. All seven required RVV CSRs are
present (vstart, vxsat, vxrm, vcsr, vl, vtype, vlenb). The `vsetvl*`
algorithm follows the V 1.0 §6 reference; reserved (vsew, vlmul)
combinations set `vtype.vill = 1` and `vl = 0`.

### Execution unit

`rtl/cpu/rvv/rvv_unit_stub.sv` is a behavioral pass-through and is
explicitly **not** an implementation of RVV arithmetic. Real arithmetic
is BLOCKED until a vector backend lands; candidates are listed in
`docs/evidence/cpu_ap/rvv-1-0-execution.yaml`.

## Ztso (Total Store Order, ratified 2024)

Specification: [Ztso ratified extension](https://docs.riscv.org/reference/isa/unpriv/ztso-st-ext.html).

The e1 big core targets **per-page selectable TSO** rather than whole-core
TSO. Rationale:

- RVWMO native code (Linux, glibc, RISC-V Android) gets the full benefit
  of weak ordering on its pages.
- x86 / ARM binary-translated code (Box64, FEX-Emu, QEMU TCG) marks its
  TSO-required pages with a PTE bit, avoiding 4-15 % fence-spam.
- Box64-style translators can selectively flip pages without modifying
  the kernel ABI.

### PTE bit assignment (informative)

Sv39 PTE bit layout (from RISC-V Privileged Spec):

```
[63:54] reserved  [53:10] PPN  [9:8] RSW  [7] D  [6] A  [5] G  [4] U
[3] X  [2] W  [1] R  [0] V
```

Bit 8 (RSW low) is "reserved for software use" and is the proposed home
for the Ztso indicator. RSW bits are guaranteed safe for OS use per
spec; the hardware ignores them, so we hijack one without breaking
generic Sv39 software. The OS opts in via `e1_ztso_ctrl` CSR bit 0.

### CSR

`rtl/cpu/csr/ztso_ctrl.sv` exposes `e1_ztso_ctrl` at CSR address `0x7C0`
(machine-mode custom region):

| Bit | Direction | Meaning |
|---|---|---|
| 0 | RW | Global Ztso permission (page bits respected) |
| 1 | RW | Whole-core TSO override (for testing) |
| 2 | RO | Last resolved page Ztso bit value |

### Enforcement

The LSU consults the TLB-fed `lsu_op_is_tso_o` line per memory op:

- TSO op load → no reordering past earlier TSO loads
- TSO op store → drain SQ before commit
- RVWMO op → standard weak-ordering rules

The actual LSU is owned by this OoO agent and is sequenced in the
back-end work (out of scope for this turn). The CSR + control surface is
in place.

## Sv57 (5-level page table, RVA23 profile)

The big core's MMU supports Sv39 (default), Sv48 (RVA22 / Android current),
and Sv57 (>= 128 TB virtual). Sv57 is enabled at boot via `satp.MODE = 10`.
Phone-class RAM today maxes ~32 GB, but the on-device LLM context and
shared-NPU virtual maps are projected to exceed Sv39's 512 GB by 2029, so
Sv57 is a hard requirement, not a future option.

Mid and little cores use Sv39 only. The cluster top respects
heterogeneous `satp.MODE` per hart; the IOMMU agent must match.

## Zicfilp / Zicfiss (control-flow integrity, ratified 2024)

Specification: [RISC-V Zicfilp / Zicfiss](https://github.com/riscv/riscv-cfi).

- **Zicfilp** (landing-pad checker) protects indirect branches: every
  forward indirect must land on a `LPAD` instruction or trap.
- **Zicfiss** (shadow stack) protects calls/returns: every `JALR` from
  a return saves to a shadow stack; mismatch traps.

The big core requires both. Mid core requires Zicfilp only (shadow-stack
silicon area cost trades against the smaller PRF). Little core does not
implement either; security-sensitive workloads must route to mid/big.

## Zacas (atomic compare-and-swap pairs, ratified 2024)

Required by RVA23 for lockless data structures wider than XLEN. Native
on big and mid cores. Little core lifts to a software libcall via the
runtime (slower; acceptable for the little-core role).

## Zicboz / Zicbom (cache block ops, ratified 2023)

- `cbo.zero` writes 64 zero bytes to a cache line without reading; used
  by `memset`, page-allocator zeroing, kernel buffer init.
- `cbo.clean` / `cbo.flush` / `cbo.inval` for DMA buffer sync.

Required across all three core roles for correct DMA / NPU / display
buffer interaction with the cache subsystem.

## Compliance and gates

| Gate | Path |
|---|---|
| RVA23 profile plan | `docs/evidence/cpu-ap-rva23-profile-plan.json` |
| RVV 1.0 execution | `docs/evidence/cpu_ap/rvv-1-0-execution.yaml` |
| CSR/trap | `docs/evidence/cpu_ap/csr-trap-evidence.yaml` |
| MMU Sv39 (Sv48/Sv57 follow) | `docs/evidence/cpu_ap/mmu-sv39-evidence.yaml` |
| riscv-arch-test + riscv-dv | `verify/riscv-arch-tests/manifest.json` |

Every gate fails closed until the corresponding DUT (CVA6 / Kunminghu) is
selectable and the test produces a signed transcript.
