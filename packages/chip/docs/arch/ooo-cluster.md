# e1 OoO CPU cluster contract

This document is the authoritative integration contract for the e1 cluster.
It binds the core-selection manifests under `generators/chipyard/`, the
cluster RTL wrapper at `rtl/cpu/cluster/e1_cluster_top.sv`, and the
benchmark / evidence gates under `docs/evidence/cpu_ap/`.

The architectural reasoning (SOTA snapshot, gap analysis, open-source
options, risks) is captured separately in
`docs/architecture-optimization/sota-2028/ooo-execution.md`. This file is
the contract.

## Topology — 1 + 3 + 4

```
+-----------------------------------------------------------------+
|                       e1 CPU cluster                            |
|                                                                 |
|  +---------------+  +---------------+  +---------------+        |
|  |   e1-ultra    |  |  e1-premium   |  |   e1-pro      |        |
|  |   1 instance  |  |  3 instances  |  |  4 instances  |        |
|  |  big core      |  |  mid core     |  |  little core  |        |
|  +-------+-------+  +-------+-------+  +-------+-------+        |
|          |                  |                  |                |
|          v                  v                  v                |
|  +-----------------------------------------------------------+  |
|  |  coherent bus + L3 + SLC  (owned by cache agent)          |  |
|  +-----------------------------------------------------------+  |
|                                                                 |
|  +-----------------------------------------------------------+  |
|  |  IOMMU/AXI4 + LPDDR5X controller (owned by memory agent)  |  |
|  +-----------------------------------------------------------+  |
|                                                                 |
|  +---------------+      +---------------+                       |
|  |  Ibex mgmt    |      |  Power/PMU    |                       |
|  |  hart (boot/  |      |  controller    |                       |
|  |  security)    |      |  (power agent)|                       |
|  +---------------+      +---------------+                       |
+-----------------------------------------------------------------+
```

Topology rationale: matches D9500 / Apple A19 Pro 2+4 + 4. We add one
big-core slot for low-thread peak (foreground app, on-device LLM prompt
processing), three mid cores for sustained background apps and the Android
foreground/background framework, four little cores for system services and
sustained low-power workloads.

## Per-role uarch contract

| Role | Count | ISA | Decode | Issue | ROB | PRF INT/FP+V | Vec | L1I/L1D | L2 | Clock (GHz) | IPC SPEC2017 int target |
|---|---|---|---|---|---|---|---|---|---|---|---|
| e1-ultra (big) | 1 | RVA23 + V + Zfh + Zvfh + Zvbb + Zvkt + Zicboz + Zicbom + Ztso + Sv57 + Smaia + Zicfilp + Zicfiss + Zacas | 8 native + 2 fused = 10 | 8 | 512 | 400/400 | 2× 256b RVV 1.0 | 64K/64K | 1 MB priv | 4.0-4.3 burst | ≥ 9 |
| e1-premium (mid) | 3 | RV64GCB + V + H + Smaia + Ssaia | 6 | 6 | 256 | 192/192 | 1× 128b RVV 1.0 | 32K/32K | 512 KB priv | 3.0-3.4 | ≥ 5.5 |
| e1-pro (little) | 4 | RV64GC + S-mode | 1 | 1 | 0 (in-order) | n/a | none | 32K/32K | 256 KB shared cluster | 1.8-2.2 | ~1.6 |
| mgmt-hart | 1 | RV32IMC (Ibex) | 1 | 1 | 0 | n/a | none | 4K/4K | n/a | 200-400 MHz | n/a |

The big-core slot is BLOCKED on Tenstorrent Ascalon-D8 license closure.
Mid-core slot is selected as XiangShan Kunminghu V2/V3; little-core slot
is selected as OpenHW CVA6; bootstrap path is Chipyard Rocket.

## Cluster RTL boundary (`rtl/cpu/cluster/e1_cluster_top.sv`)

Parameters:

- `NUM_BIG_CORES`     (default 1)
- `NUM_MID_CORES`     (default 3)
- `NUM_LITTLE_CORES`  (default 4)
- `RESET_VECTOR`      (default `0x8000_0000`)
- `AXI_ADDR_W` / `AXI_DATA_W` / `AXI_ID_W` (default 64 / 128 / 8)

Per-core ports:

- AXI4 master bus to the cache agent's coherent fabric
- IRQ inputs: `irq_ext[1:0]`, `irq_timer`, `irq_software`, `debug_req`
- Power-island: `pwr_island_en`, `pwr_retention`
- Hart ID: 64-bit, assigned by SoC top
- Observability: committed PC + halt status

The wrapper is presently a parameterized tie-off skeleton. It is gated by
`E1_HAVE_*` compile defines so individual core instances are linked only
when the corresponding upstream RTL is checked out. The cluster always
synthesizes; absent cores are tied to safe-idle.

## CSR additions owned by this domain

| CSR | Address | Width | Reset | Purpose |
|---|---|---|---|---|
| `mcycle` | `0xB00` | 64 | 0 | Cycle counter (Zihpm baseline) |
| `minstret` | `0xB02` | 64 | 0 | Retired instruction counter |
| `mhpmcounter3..15` | `0xB03..0xB0F` | 64 | 0 | Programmable event counters |
| `mhpmevent3..15` | `0x323..0x32F` | XLEN | 0 | Event selectors |
| `vstart` | `0x008` | XLEN | 0 | RVV partial execution position |
| `vxsat` | `0x009` | 1 | 0 | RVV fixed-point saturation flag |
| `vxrm` | `0x00A` | 2 | 0 | RVV fixed-point rounding mode |
| `vcsr` | `0x00F` | 3 | 0 | combined vxrm/vxsat |
| `vl` | `0xC20` | XLEN | 0 | current vector length |
| `vtype` | `0xC21` | XLEN | `vill=1` | current vector type |
| `vlenb` | `0xC22` | XLEN | `VLEN/8` | bytes per vector register |
| `e1_ztso_ctrl` | `0x7C0` | XLEN | 0 | bit 0 = global Ztso permission; bit 1 = whole-core TSO override; bit 2 = last-page Ztso (RO) |

PTE-bit assignment for Ztso uses Sv39 RSW bit 8 (per `rtl/cpu/csr/ztso_ctrl.sv`).

## Macro-op fusion contract

Detection happens at decode/dispatch. The contract enumerates 19 fusable
pair kinds in `rtl/cpu/fusion/fusion_pkg.sv`. Required pairs per
docs/architecture-optimization/sota-2028/ooo-execution.md Section E.6:

- `lui + addi` (`li imm32`)
- `slli + add`
- `auipc + jalr`
- `addi + bne`
- `lui + ld`

Fusion detection is uarch-defined and not required for ISA correctness.
Verification is at `verify/cocotb/cpu/test_fusion_table.py`.

## Coordination with other agents

| Agent | Interface owned by | Owned by this agent |
|---|---|---|
| BPU | `rtl/cpu/bpu/bpu_pkg.sv` (FTQ structs, PMU events) | Consumes FTQ. Re-exports BPU PMU events into Zihpm. |
| Cache | per-core AXI4 master ports + L1I/L1D port packages | Provides per-core AXI4 master ports + TLB resolve feeds. |
| Memory | IOMMU/AXI4 downstream | Provides top-level master AXI4 port; trusts memory agent for SMMU / LPDDR5X. |
| Power | DVFS table, retention voltages, power islands | Provides power-island enable + retention pin per core. |
| Compiler | `march` / `mabi` strings, LLVM scheduling model | Consumes the compiler agent's pinned LLVM; provides the canonical extension matrix. |

## Schedule

Per docs/architecture-optimization/sota-2028/ooo-execution.md Section F.
Schedule risk:

- 2026 Q4: pick big-core decision (Ascalon-D8 license closes OR commit to
  Kunminghu scale-up fork).
- 2027 Q1-Q4: integration + verification, FireSim full-system Linux.
- 2027 Q4: RTL freeze.
- 2028 H1: dev-board silicon tapeout.
- 2028 H2: sample silicon, CTS/VTS work.
- 2029: phone product silicon and certification.

Until silicon evidence exists, every flagship-class IPC / GB6 / SPEC
claim remains BLOCKED. The gates in `docs/evidence/cpu_ap/` are the audit
record.

## Required gates

```sh
make core-selection-check               # generators/chipyard/* manifests
make chipyard-generator-check           # docs/generators/chipyard/eliza-rocket-manifest.json
make xiangshan-generator-check          # external/xiangshan/ pin
make cva6-generator-check               # external/cva6/ pin or chipyard cva6 submodule
make boom-generator-check               # external/boom/ pin or chipyard boom submodule
make linux-boot-check                   # build/evidence/cpu_ap/eliza_e1_linux_boot.log
make cocotb-cpu-extended                # CSR/trap + MMU host-side checks
make coremark                           # benchmarks/cpu/coremark/manifest.json
make embench                            # benchmarks/cpu/embench/manifest.json
make jetstream                          # benchmarks/cpu/jetstream/manifest.json
make spec-skeleton                      # benchmarks/cpu/spec/manifest.json (license-blocked)
```
