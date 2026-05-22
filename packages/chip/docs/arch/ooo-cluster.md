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
| e1-ultra (big) | 1 | RV64GCB + V + H + Smaia + Ssaia + Sv48 | 8 | 8 | 512 | 256/256 | 1× 128b RVV 1.0 | 64K/64K | 1 MB priv | 3.2-3.4 burst | ≥ 6.5 |
| e1-premium (mid) | 3 | RV64GCB + V + H + Smaia + Ssaia | 6 | 6 | 256 | 192/192 | 1× 128b RVV 1.0 | 32K/32K | 512 KB priv | 3.0-3.4 | ≥ 5.5 |
| e1-pro (little) | 4 | RV64GC + S-mode | 1 | 1 | 0 (in-order) | n/a | none | 32K/32K | 256 KB shared cluster | 1.8-2.2 | ~1.6 |
| mgmt-hart | 1 | RV32IMC (Ibex) | 1 | 1 | 0 | n/a | none | 4K/4K | n/a | 200-400 MHz | n/a |

The big-core slot is the open XiangShan Kunminghu V3 scale-up (8-wide /
ROB 512); the upstream commit is pinned and requires no vendor IP license,
but the external XiangShan checkout and the 8-wide scale-up microbench are
still tracked-not-integrated. Mid-core slot is selected as XiangShan
Kunminghu V2/V3; little-core slot is selected as OpenHW CVA6; bootstrap
path is Chipyard Rocket. Tenstorrent Ascalon-D8 was surveyed as the
leading commercial flagship-class core but rejected: its mobile-volume IP
license terms are not published.

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
| BPU | `rtl/cpu/bpu/bpu_pkg.sv` (FTQ structs, PMU events) | Consumes FTQ. Re-exports BPU PMU events into Zihpm via `bpu_to_zihpm_remap`. |
| Cache | per-core AXI4 master ports + L1I/L1D port packages | Provides per-core AXI4 master ports + TLB resolve feeds. |
| Memory | IOMMU/AXI4 downstream | Provides top-level master AXI4 port; trusts memory agent for SMMU / LPDDR5X. |
| Power | DVFS table, retention voltages, power islands | Provides power-island enable + retention pin per core. |
| Compiler | `march` / `mabi` strings, LLVM scheduling model | Consumes the compiler agent's pinned LLVM; provides the canonical extension matrix. |

### Cross-domain interface contracts (cluster boundary)

Each contract is enumerated in a single SystemVerilog package and the
cluster wrapper `e1_cluster_top.sv` imports them. The package owner is
the one that drives wire semantics; the OoO domain is the consumer (or
producer) named in the third column.

| Package | Owner | Used by OoO cluster for |
|---|---|---|
| `rtl/cache/ftq_to_l1i_pkg.sv` | cache | Per-core FTQ → L1I prefetch request stream. The BPU agent populates the producer, but the cluster boundary aggregates per-core. |
| `rtl/cache/lsu_to_l1d_pkg.sv` | cache | Per-core 2×128 b LSU → L1D request/response. Two read + two write ports per cycle, banked 8 ways. Bank conflicts surface as `replay`. |
| `rtl/interconnect/axi4/e1_axi4_pkg.sv` | memory | AxBURST / AxSIZE / AxCACHE / AxPROT / AxQoS encodings on the per-core master ports. The cluster forwards `QOS_CPU_LATENCY = 11` unless overridden via `cluster_qos_class_i`. |
| `rtl/cpu/bpu/bpu_pkg.sv` | BPU | `pmu_event_e` strobes (20 entries, 5-bit IDs starting at 0). Translated into the Zihpm event bus by `rtl/cpu/csr/bpu_to_zihpm_remap.sv`. |
| `rtl/cpu/csr/zihpm.sv` | OoO (this) | `hpm_event_e` (8-bit IDs). Branch block 1..20 mirrors BPU enum after the +1 shift; cache 32..47, MMU 48..63, OoO 64..95 own the rest of the partition. |
| `rtl/cpu/csr/ztso_ctrl.sv` | OoO (this) | Ztso PTE-bit (Sv39 RSW bit 8) and CSR `0x7C0` global/per-core overrides. The LSU consumes `lsu_op_is_tso_o` and the coherent bus uses it to gate store-buffer drain and load-ordering enforcement. |
| `rtl/cpu/fusion/fusion_pkg.sv` | OoO (this) | 19 macro-op fusion kinds. The dispatch stage walks the lead/follow pair, the cluster does not present them outside the core. |

### BPU → Zihpm PMU event remap

The BPU PMU bundle uses raw 5-bit IDs 0..19. The Zihpm event bus places
`EVT_NONE = 0` and runs the BPU events at IDs 1..20. Because the BPU enum
ordering and the Zihpm enum ordering have historically drifted (notably:
BPU id 1 is `PMU_BR_MISP`, Zihpm id 1 is `EVT_BR_PRED`), the BPU strobes
*must not* be wired directly to `zihpm.event_bus_i`. Use the
`bpu_to_zihpm_remap` adapter under `rtl/cpu/csr/`. The adapter is purely
combinational and renames by *name*, not by raw ID. The mapping is
audited by `scripts/check_pmu_event_alignment.py`, which emits
`docs/evidence/cpu_ap/pmu-event-alignment.json` and fails closed if either
side adds an event without updating the other.

The canonical (Zihpm-side) naming for the FTB miss event is
`EVT_BTB_MISS`; the BPU enum spells it `PMU_FTB_MISS`. The remap
explicitly aliases the two — RVA23 published profile uses `BTB_MISS` so
the Zihpm-side name is preserved in the CSR contract.

### FTQ → L1I prefetch path

Producer: BPU agent (`bpu_top.sv`). Consumer: cache agent (`l1i_*.sv`).
The cluster exposes one channel per core (`ftq_l1i_req_o`,
`ftq_l1i_valid_o`, `ftq_l1i_ready_i`, `ftq_l1i_flush_o`). The semantics
documented in `rtl/cache/ftq_to_l1i_pkg.sv`:

  - 40-bit physical address, 64-byte L1I line aligned.
  - 3-bit confidence (0 weakest, 7 strongest taken-branch confidence).
  - `branch_target` hint: 1 if the request originates from a branch
    target, 0 if sequential or BTB-miss recovery.
  - Single-cycle valid+ready handshake.
  - On `flush` the L1I drops any in-flight prefetch but does not abort
    L2 fills already started for the dropped request.

### LSU → L1D path

Producer: OoO domain (this). Consumer: cache agent (`l1d_*.sv`). Per
`rtl/cache/lsu_to_l1d_pkg.sv` the contract is:

  - 2 × 128 b read ports + 2 × 128 b write ports per core.
  - 4-cycle load-use latency target.
  - 40-bit physical address (post-TLB), 8-byte tag.
  - `size` field: 0..3 = sub-double, 4 = quad-128 b.
  - `ack` strobe completes a request; `replay` strobe re-issues on bank
    conflict or MSHR pressure; `ecc_uncorrectable` propagates SECDED
    double-bit errors to the LSU for trap entry.

### AXI4 per-core master ports

Per `rtl/interconnect/axi4/e1_axi4_pkg.sv` constants:

  - `BURST_INCR` is the default; `BURST_FIXED` reserved for MMIO devices.
  - `SIZE_16B` matches the 128 b data bus (the e1 cluster default).
  - `CACHE_WRITE_BACK_RW = 4'b1111` on cached lines; device MMIO uses
    `CACHE_DEVICE_NON_BUFFERABLE = 4'b0000`.
  - `PROT_INSN_NS_PRIV = 3'b111` on I-fills; `PROT_DATA_NS_PRIV = 3'b011`
    on supervisor/M-mode data; `PROT_DATA_NS_UNPRIV = 3'b010` on user.
  - `QOS_CPU_LATENCY = 4'd11` default. The cluster wrapper accepts an
    override on `cluster_qos_class_i` so the power agent can demote
    cores during heavy display / camera scanout.
  - The max burst length is `MAX_BURST_LEN_INCR = 256` beats, but cache
    line refills cap at the line-size / data-width quotient
    (`64 B / 16 B = 4` beats for a 128 b data bus).

### Ztso PTE bit plumbing

The OoO domain owns the Ztso control surface:

  - `rtl/cpu/csr/ztso_ctrl.sv` exposes CSR `0x7C0` (bit 0 = global Ztso
    permission, bit 1 = whole-core TSO override).
  - The TLB feeds back `tlb_page_ztso_bit_i` from PTE bit 8 (Sv39 RSW).
  - The LSU consumes `lsu_op_is_tso_o` to decide whether to (a) drain
    the store queue at store-issue time, (b) inhibit load reordering
    past a TSO load.
  - The coherent bus respects the TSO flag end-to-end: an L1D
    write-back triggered by a TSO store must observe the
    write-acknowledge ordering before any subsequent load departs.

Until the LSU lands, `lsu_op_is_tso_o` is exposed to the cluster
boundary but unconsumed; the gate at
`docs/evidence/cpu_ap/csr-trap-evidence.yaml` tracks this as BLOCKED.

## Schedule

Per docs/architecture-optimization/sota-2028/ooo-execution.md Section F.
Schedule risk:

- 2026 Q4: confirm big-core path (open Kunminghu V3 8-wide scale-up fork)
  against the 8-wide scale-up microbench.
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
