# Interconnect contract

`rtl/interconnect/e1_axi_lite_interconnect.sv` is the first synthesizable interconnect scaffold for the Linux-capable SoC contract. It connects one CPU-side AXI-Lite manager port to DRAM, interrupt-controller, DMA-control, NPU, and display target ports. `rtl/interconnect/e1_linux_soc_contract.sv` also arbitrates the prototype DMA AXI-Lite master onto the same DRAM model used by CPU-side traffic.

## Decode map

| Address range | Target | RTL target |
| ---: | --- | --- |
| `0x0C00_0000` - `0x0C00_0FFF` | Interrupt controller | `e1_interrupt_controller` |
| `0x1001_0000` - `0x1001_0FFF` | DMA control | `e1_dma` MMIO target wrapper |
| `0x1002_0000` - `0x1002_0FFF` | NPU control | `e1_npu` MMIO target wrapper |
| `0x1003_0000` - `0x1003_0FFF` | Display control | `e1_display` MMIO target wrapper |
| `0x8000_0000` - `0x8FFF_FFFF` | DRAM aperture | `e1_axi_lite_dram` model |
| Other | Decode error | AXI-Lite `DECERR`, read data `0xDEAD_BEEF` |

The existing e1-chip top remains a separate single-cycle MMIO validation design with its own map in `docs/arch/memory-map.md`. The AXI-Lite contract wrapper is `rtl/interconnect/e1_linux_soc_contract.sv` and is used by contract-level cocotb tests.

## Current limitations

The scaffold supports one outstanding read and one outstanding write transaction. The write address and write data channels may arrive independently, but the interconnect issues a target-side write only after both channels have been accepted. This intentionally avoids a full bus fabric while preserving the externally visible channel timing, response codes, and address decode rules needed by firmware and OS planning.

The DMA/CPU merge point in `rtl/interconnect/e1_linux_soc_contract.sv` is a fixed CPU-priority mux into the SRAM-backed DRAM model. NPU and display are exposed here as software-visible MMIO targets only; the NPU descriptor master fails closed in this scaffold, and display framebuffer reads are not routed through a production memory fabric. It is not a cache-coherent fabric, not a QoS arbiter, and not evidence for bandwidth fairness, latency bounds, burst behavior, ordering between independent masters, or starvation freedom. Any future production fabric must add explicit arbitration policy, outstanding transaction limits, response-ordering rules, performance counters, and contended latency/bandwidth evidence before CPU, DMA, display, NPU, camera/ISP, or GPU/2D traffic claims can be made.

It is also not an AXI4 or TileLink implementation. The current path has no
burst length, transaction IDs/source IDs, TileLink channel semantics, atomic
operations, cacheability attributes, or coherent/non-coherent bridge policy.
Any AXI4, TileLink, or coherent fabric claim remains blocked until bridge
ordering, response attribution, and cacheability tests are checked in.

## DMA containment boundary

The current DMA path is not an IOMMU. It is a bounded scaffold path: CPU-side software programs the DMA registers through the `0x1001_0000` MMIO window, and DMA master reads/writes are routed only to the SRAM-backed DRAM model. DMA attempts to use interrupt-controller, peripheral, or other MMIO addresses are expected to return DRAM-model `SLVERR` after address translation into the DRAM target and must not mutate those MMIO registers. `verify/cocotb/test_cpu_mem_intc_contract.py` covers this negative path.

This proves local address containment for the scaffold only. Coherent DMA, page-table translation, fault reporting to a kernel driver, and production IOMMU/SMMU behavior remain blocked.

## Production fabric gates

A Linux/Android-capable interconnect must make the following contracts executable before it can replace the scaffold:

| Gate | Required production contract |
| --- | --- |
| Reset ROM / boot memory | Place reset ROM, boot SRAM, firmware handoff, DRAM init, and OpenSBI memory discovery in the same access map. |
| AXI/TL fabric | Replace the AXI-Lite scaffold with an AXI4, TileLink, or equivalent fabric contract covering bursts, IDs/source IDs, ordering, atomics, backpressure, and bridges. |
| Coherency | Declare coherent DMA support or a non-coherent ownership/cache-maintenance ABI for every DMA-capable client. |
| Cacheability | Document Linux-visible cacheability attributes for ROM, SRAM, DRAM, MMIO, and DMA buffers; prove non-coherent cache maintenance when hardware coherency is absent. |
| IOMMU/SMMU | Place every bus master behind a translated or explicitly allowlisted domain; unauthorized transactions must fault without MMIO side effects. |
| Fault reporting | Surface page fault reporting to software with master ID, address, access type, permission/syndrome bits, and recovery behavior. |
| QoS | Specify arbitration, priority, starvation bounds, counters, and bandwidth/latency budgets for CPU, DMA, NPU, display, camera/ISP, and GPU/2D traffic. |
| CLINT/PLIC access map | Reserve CLINT/ACLINT and PLIC/IMSIC windows from DMA, document CPU privilege access, and prove DMA cannot mutate timer or interrupt-controller state. |
| DRAM/LPDDR path | Attach a real DRAM controller/PHY or integrated IP boundary with measured LPDDR bandwidth/latency evidence; the current SRAM model cannot satisfy this gate. |

Phone-class 2028 memory claims remain blocked until `docs/evidence/memory/uma-dram-evidence-gate.yaml` is intentionally replaced or satisfied with real DRAM, cache hierarchy, UMA/coherency, IOMMU/SMMU, and contended bandwidth and latency artifacts.
The contract wrapper uses CPU-wins arbitration when CPU and DMA requests target the same AXI-Lite path. DMA and CPU accesses must stay inside a bounded physical-address allowlist, and unsupported access paths fail closed.

No release, Android, AI-throughput, display-smoothness, or memory-bandwidth claim may rely on this scaffold until a real interconnect, memory controller, cache coherency, IOMMU, and QoS implementation has checked evidence.

## AXI4 production fabric (in repo)

The production-path AXI4 burst-capable fabric is `rtl/interconnect/axi4/e1_axi4_interconnect.sv` with package `e1_axi4_pkg.sv`. It supersedes the AXI-Lite scaffold on the south side once the cache agent's `rtl/cache/coherence/tl_c_to_chi_bridge.sv` lands on top of the CHI bridge.

Parameters that the SoC top must wire correctly:

| Parameter | Default | Cluster (`e1_cluster_top`) needs | Notes |
| --- | --- | --- | --- |
| `NUM_MASTERS` | 4 | 8 (`NUM_CORES`) | OoO + mid + little cluster has 1+3+4 cores; each core is one AXI4 master. NPU / display / GPU / DMA add additional masters at the cache-agent's coherent bus or the south AXI4 ring. |
| `ID_WIDTH` | 4 | 8 (`AXI_ID_W`) | Cluster outputs 8-bit `axi_aw_id_o[NUM_CORES-1:0][7:0]`. Interconnect prefixes a `MASTER_IDX_W = $clog2(NUM_MASTERS+1) = 4` master tag on the slave side, so a downstream slave sees a 12-bit AxID `{master_idx[3:0], original_axid[7:0]}`. |
| `DATA_WIDTH` | 128 | 128 (`L1D_DATA_W`) | L1D cache line width; matches LPDDR5X 8n-prefetch beat. |
| `BURST_LEN_W` | 8 | 8 (full AXI4) | INCR up to 256 beats; WRAP/FIXED capped at 16. |
| `MAX_OUTST` | 16 | ≥16 | Per-master outstanding-transaction limit driving AW/AR ready deassertion. |

The cluster's `axi_aw_*_o[NUM_CORES-1:0]` aggregates connect 1:1 to the interconnect's `m_aw*` ports.

## CHI bridge boundary (cache agent contract)

`rtl/interconnect/chi_bridge/e1_chi_to_axi4_bridge.sv` is the bridge between the cache agent's CHI-class fabric (L3 ↔ SLC, snoop-aware) and the south AXI4. Contract:

- North port: CHI requests with `chi_req_is_exclusive`, `chi_req_stash`, and cache attributes mapped from CHI MemAttr to AXI4 `AxCACHE` per `CACHE_WRITE_BACK_RW` and friends in `e1_axi4_pkg.sv`.
- South port: AXI4 master that the interconnect treats as another upstream master. The bridge is the ONLY producer of coherent traffic on the south fabric; all other masters (NPU, GPU, display, DMA) attach directly to the AXI4 interconnect as non-coherent.
- In the cache-agent contract, `rtl/cache/slc/e1_slc.sv` is intended to sit between L3 and the bridge, with DRAM access flowing from the bridge through `e1_axi4_interconnect` and `e1_dram_ctrl` toward DFI 5.0. This is RTL/block-level contract evidence only; it is not SoC-top, LPDDR PHY, training, Linux, Android, or phone-class DRAM evidence.

## IOMMU isolation policy

`rtl/iommu/e1_riscv_iommu.sv` is the local upstream-AXI4-filtered IOMMU RTL intended for non-CHI masters. Current evidence is a standalone/local subset and does not prove full SoC, Linux, Android, or phone integration. The dma-buf v2 contract in `docs/arch/dma-buf-v2.md` describes how NPU, GPU, display, ISP, and camera buffers carry an exporter-stamped (devid, pasid) tuple that becomes the AXI4 `aw_devid` / `aw_pasid` USER bits at the IOMMU's upstream port. Coherent traffic from the CHI bridge does NOT pass through this IOMMU — coherent masters are inside the trusted domain.

The IOMMU's evidence gate is `docs/evidence/memory/iommu-evidence-gate.yaml`; the RTL is verified by `verify/cocotb/iommu/test_riscv_iommu.py` (16 tests, covering capabilities, allowlist/PASID behavior, page-request/ATS/TR_REQ surfaces, minimal DDT + Sv39 first-stage walk, identity G-stage KAT, unmapped-fault recording, IOFENCE.C fetch/decode, invalid CQ opcode fail-closed behavior, and fault-queue register visibility).
