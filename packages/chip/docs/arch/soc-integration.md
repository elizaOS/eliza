# SoC integration contract

`e1_soc_integrated` is the top-level SystemVerilog integration of the
eight domain agent deliverables.  It is **not** a replacement for the
v0 `e1_chip_top` + `e1_soc_top` path used by the existing release flow;
it is a parallel top that demonstrates the cross-domain interfaces wire
up at the SystemVerilog level and is gated by a fail-closed evidence
manifest.

## Domain instantiation map

| Module                       | Owner agent | Role in `e1_soc_integrated` |
|------------------------------|-------------|-----------------------------|
| `bpu_top`                    | BPU         | Branch prediction; emits `pmu_strb[19:0]` + FTQ fetch entries |
| `bpu_to_zihpm_remap`         | CSR         | Remap BPU PMU IDs → Zihpm event-bus slots |
| `ftq_to_l1i_shim`            | BPU         | FTQ entry → L1I prefetch request (`ftq_prefetch_req_t`) |
| `zihpm`                      | CSR         | mcycle, minstret, mhpmcounter3..15 |
| `e1_cluster_top`             | OoO         | Lite tie-off mode; presents AXI4 master contract |
| `e1_slc`                     | Cache       | One small SLC slice (64 KB / 4-way / 2-bank) driving CHI request traffic into the bridge |
| `e1_slc_to_chi_line_shim`    | (adapter)   | Maps SLC 512-bit `dram_acq` lines onto the CHI burst request signals |
| `e1_chi_to_axi4_bridge`      | Interconnect| CHI ↔ AXI4 burst translation; drives fabric master `m[0]` |
| `e1_riscv_iommu`             | IOMMU       | RISC-V IOMMU v1.0.1; MMIO bridged onto debug aperture; drives fabric master `m[1]` |
| `e1_axi4_interconnect`       | Interconnect| 2-master × 4-slave fabric (DRAM + decode-err sentinels) |
| `e1_axi4_dram_model`         | Memory      | Behavioural DRAM south of the AXI4 fabric |
| `pmc_top`                    | Power       | AON Ibex management core mailbox + droop / AVFS telemetry |
| `e1_weight_buffer_sram`      | Memory / PD | Sky130 OpenRAM 2 KB hard macro at 0x1004_0000 |
| `e1_bootrom`                 | (legacy)    | Boot vector ROM at 0x0000_0000 |
| `e1_peripherals`             | (legacy)    | Timer + GPIO at 0x1000_0000 |
| `e1_dma`                     | (legacy)    | DMA at 0x1001_0000 |
| `e1_npu`                     | (legacy)    | NPU scaffold at 0x1002_0000 |
| `e1_display`                 | (legacy)    | Display at 0x1003_0000 |

## Cross-domain interfaces

Every edge between two domains must be wired exactly once; this top is
the canonical location for the wiring.

### BPU → Zihpm (PMU events)

```text
bpu_top.pmu_strb[19:0]  →  bpu_to_zihpm_remap.bpu_strobes_i
                            │
                            └→  zihpm.event_bus_i[255:0]
                                 ↓
                                 mhpmcounter[3..15] increment per
                                 mhpmevent selector
```

Width contract: BPU emits 20 PMU strobes (`PMU_BR_PRED..PMU_SC_OVERRIDE`,
5-bit IDs); the remap shifts them by +1 (to leave `EVT_NONE=0`) and
renames `PMU_FTB_MISS` → `EVT_BTB_MISS`.  See
`scripts/check_pmu_event_alignment.py` for the strict harmonization
checker.  Verified by
`verify/cocotb/integration/test_cross_domain_interfaces.py::bpu_pmu_strobe_increments_zihpm_counter`.

### BPU → L1I (FTQ prefetch)

```text
bpu_top.fetch_entry        →  ftq_to_l1i_shim.fetch_entry
bpu_top.fetch_valid        →  ftq_to_l1i_shim.fetch_entry_valid
resolve_i.misprediction    →  ftq_to_l1i_shim.flush_valid
                                ↓
                                ftq_prefetch_req_t {paddr_line[39:0],
                                                    confidence[2:0],
                                                    branch_target}
                                exposed on SoC port l1i_prefetch_req_o
```

Width contract: 39-bit Sv39 virtual PC drops the bottom 6 bits and
zero-extends to a 40-bit physical line address.  Confidence is
{0,4,5,6} for {BR_NONE, BR_COND, BR_CALL, BR_RET}.  See
`rtl/cache/ftq_to_l1i_pkg.sv` for the canonical packet shape.  Verified
by `ftq_l1i_shim_emits_prefetch_on_taken_target` and
`ftq_l1i_shim_flushes_on_misprediction`.

### CPU cluster → AXI4 fabric

The cluster presents 8 per-core AXI4 master ports (1 big + 3 mid + 4
little) with `AXI_ADDR_W=40`, `AXI_DATA_W=128`, `AXI_ID_W=8`.  The
integrated top currently routes only the cache-side `CHI → AXI4` bridge
into the fabric (master 0); the per-core cluster ports stay tied off in
`e1_cluster_top` lite mode until the core wrappers ship.  This is the
documented BLOCKED edge — see
`docs/evidence/integration/cross-domain-interfaces.yaml`.

### CHI → AXI4 (cache south boundary)

```text
SLC client (MMIO fixture @ 0x1008_0000)
   →  e1_slc.dram_acq_*  (line transaction)
      →  e1_slc_to_chi_line_shim  (line ↔ CHI burst translator)
         →  e1_chi_to_axi4_bridge  (CHI request side)
            →  fabric master[0]
               →  fabric slave[0]
                  →  e1_dram_ctrl  →  e1_axi4_dram_model
```

One small SLC slice (`SIZE_BYTES=65536`, `WAYS=4`, `BANKS=2`,
`LINE_BYTES=64`, `NUM_CLIENTS=2`) is instantiated to source real CHI
request traffic from the integrated top.  The slice receives line
requests from a single MMIO-controlled client fixture so the cocotb
integration test can drive the CHI bridge end-to-end without a full
cache hierarchy.  Production SLC geometry stays under
`verify/cocotb/cache/`.

The `e1_chi_to_axi4_bridge` issues 6-bit IDs; the fabric runs 4-bit IDs
for the rest of the masters.  An adapter at the boundary slices the
low 4 bits and pads the high 2 bits to zero on the way back.  See
`rtl/top/adapters/README.md` for the documented width drift.  Verified
by `test_slc_passthrough` (single line read) and
`test_dram_ctrl_dfi_traffic` (back-to-back reads through the DRAM
controller scheduler).

### IOMMU translation (non-coherent masters)

```text
DMA fixture (MMIO @ 0x1007_0000)
   →  e1_riscv_iommu.u_*[0]  (upstream master[0])
      →  device-id allowlist check
         →  authorised  →  AXI4 d_*  →  fabric master[1]  →  DRAM
         →  rejected    →  fault queue staging
                        →  fault_irq / fault_count_dbg
                        →  FQT advances (readable via MMIO bridge)

CPU MMIO  →  iommu_mmio aperture @ 0x1006_0000 (4 KiB)
   →  AXI-Lite slave on the IOMMU (DDTP, CQB, FQB, FQH/FQT, ...)
```

The IOMMU surfaces `fault_irq`, `page_req_irq`, and `cmd_complete_irq`.
The integration top exposes `fault_irq` + `fault_count` at the SoC
boundary and bridges the IOMMU's 12-bit AXI-Lite MMIO window onto the
v0 32-bit debug aperture at `0x1006_0000`.  Each 64-bit IOMMU register
is reached by a write-low / write-high pair (`addr[2]==0` stashes the
low half; `addr[2]==1` launches an AXI-Lite write with
`{wdata, stash}`).  Reads launch an AR on every 4-byte access and
return the low half of the IOMMU's 64-bit response.

The CPU is coherent and does **not** route through the IOMMU; it uses
the CHI bridge directly.  The DMA fixture at `0x1007_0000` lets cocotb
inject a single AXI4 transaction at one IOMMU upstream port so the
fault path can be exercised without instantiating a full NPU / DMA /
display engine.  Verified by `iommu_fault_count_initially_zero`
(observability baseline) and `test_iommu_programmed_fault` (DDTP
program + unauthorised IOVA → fault record).

### PMC mailbox (AON ↔ main rail)

```text
mmio_addr[31:16] == 0x1005_xxxx     →  pmc_top.mbox_*
                                       ↓
                                       reg_tx_*, reg_rx_*, reg_dvfs_*
                                       ↓
                                       wake_irq_o, thermal_irq_o,
                                       dvfs_request_*, droop telemetry
```

The PMC AON Ibex consumes telemetry and writes DVFS requests; the
mailbox surface is documented in `rtl/power/power_pkg.sv`.  Note that
the PMC mailbox read path is registered (`rdata_q`), so a CPU read
takes one extra cycle compared to the combinational v0 peripherals.

## Address map

| Base         | Length  | Region        | Notes |
|--------------|---------|---------------|-------|
| `0x0000_0000`| 256 B   | Boot ROM      | unchanged from v0 |
| `0x0200_0000`| 64 KiB  | CLINT         | msip + mtimecmp + mtime |
| `0x1000_0000`| 256 B   | Peripherals   | timer + GPIO |
| `0x1001_0000`| 256 B   | DMA           | unchanged |
| `0x1002_0000`| 256 B   | NPU           | unchanged |
| `0x1003_0000`| 256 B   | Display       | unchanged |
| `0x1004_0000`| 2 KiB   | Weight buffer | Sky130 OpenRAM hard macro |
| `0x1005_0000`| 4 KiB   | PMC mailbox   | new in `e1_soc_integrated` |
| `0x1006_0000`| 4 KiB   | IOMMU MMIO    | RISC-V IOMMU v1.0.1 registers (DDTP/CQB/FQB/FQH/FQT/...); 64-bit registers split across two 32-bit halves on the v0 aperture |
| `0x1007_0000`| 256 B   | IOMMU DMA fixture | cocotb-driven AXI4 master into `e1_riscv_iommu.u_*[0]`; one single-beat transaction with programmable IOVA + DEV_ID |
| `0x1008_0000`| 256 B   | SLC client fixture | cocotb-driven SLC line request into `u_slc`; PADDR_LINE_LO/HI / CTRL / STATUS / GRANT_LO |
| `0x8000_0000`| 4 KiB   | DRAM aperture | behavioural; main fabric DRAM separate |

The 40-bit fabric DRAM lives behind `e1_axi4_interconnect` and is
addressed separately from the v0 32-bit MMIO aperture above.  The two
share no addresses: the fabric DRAM is the south side of the cache
hierarchy; the v0 DRAM aperture is what the legacy DMA / NPU /
display masters drive.

## Documented adapter drift

| Adapter location | Reason |
|------------------|--------|
| CHI bridge ID width 6 → fabric ID width 4 | `e1_chi_to_axi4_bridge` declares `ID_WIDTH=6` per AMBA CHI; the fabric uses 4-bit IDs.  Adapter slices the low 4 bits on the master side and zero-pads the high 2 bits on the response side.  Tracked in `rtl/top/adapters/README.md`. |
| IOMMU downstream ID width 6 → fabric ID width 4 | Same drift as the CHI bridge; same adapter pattern. |
| Cluster AXI4 ID width 8 → fabric ID width 4 | BLOCKED until per-core cluster wrappers ship.  When unblocked, the cluster's 8-bit IDs (`{cluster_id, core_id, hart_local_id}`) get sliced to the fabric's 4-bit width with the same documented pattern. |

## What this top does NOT prove

These items remain BLOCKED until later work; the integration top is
explicit about them:

- Real CPU execution (no core wrappers in lite mode).
- Real coherent MESI traffic (cache RTL not instantiated; covered in
  `verify/cocotb/cache/`).
- Real DFI 5.0 PHY (BLOCKED under
  `docs/evidence/memory/lpddr-phy-procurement.yaml`).
- IPC / GB6 / MLPerf numbers — BLOCKED until silicon.

## Evidence

| Artifact | Contract |
|----------|----------|
| `docs/evidence/integration/soc-boot-smoke.yaml` | Boot-smoke cocotb pass / fail; fail-closed on Verilator absence |
| `docs/evidence/integration/cross-domain-interfaces.yaml` | Cross-domain edge wiring proofs; lists BLOCKED edges |
| `scripts/check_soc_integration.py` | Gate verifying all cross-domain interfaces are wired |
| `make soc-integration-check` | Aggregate gate |
| `make cocotb-soc-boot-smoke` | Boot-smoke cocotb |
| `make cocotb-cross-domain` | Cross-domain interfaces cocotb |
