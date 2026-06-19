# Memory subsystem contract

`rtl/memory/e1_axi_lite_dram.sv` provides the current synthesizable DRAM boundary model. It is a small AXI-Lite SRAM-backed stand-in for an external DRAM controller and PHY.

## AXI-Lite behavior

| Property | Current scaffold |
| --- | --- |
| Data width | 32 bits |
| Address width | 32 bits at the SoC boundary |
| Write strobes | Byte strobes honored |
| Outstanding requests | One write response and one read response at a time |
| Response codes | `OKAY` for implemented aligned accesses, `SLVERR` for out-of-range or unaligned DRAM-local accesses |
| Reset contents | Unspecified |

The model accepts independently arriving write address and write data channels. It performs the write only after both channels have been captured.

## DRAM target

The long-term Linux-capable target reserves `0x8000_0000` and above for system DRAM. The RTL model only implements a small local window under that aperture for tests and synthesis. A real integration will replace the model with a memory controller boundary while preserving the software-visible base address.

## Actual capability

The current implementation is 4 KiB of SRAM-backed storage: `1024` 32-bit words behind a single-beat AXI-Lite target. It can validate word alignment, byte strobes, decode containment, and DMA error propagation in local simulation. It cannot establish any phone-class capacity, bandwidth and latency, page-fault, cache-hit, cache-miss, refresh, training, or thermal behavior.

Within `rtl/interconnect/e1_linux_soc_contract.sv`, CPU-side DRAM traffic and the prototype DMA master share the SRAM-backed DRAM model through a fixed CPU-priority mux. That mux is useful for containment tests, but it is not a production fabric, not a QoS arbiter, not a fairness guarantee, and not a cache-coherent fabric.

The reset ROM and boot SRAM story is also incomplete. The e1-chip ROM is a
contract/identity ROM, while the separate executable RV64 reset scaffold is not
yet integrated with boot SRAM, DRAM initialization, OpenSBI, or Linux memory
discovery. A Linux-capable memory system needs an immutable reset path, a
defined boot SRAM window or equivalent scratch storage, DRAM training before
use, and a handoff transcript proving OpenSBI sees initialized memory.

## Generated AP memory audit

The generated Chipyard AP artifacts currently expose one Linux-sized memory
window: `memory@80000000` at `0x80000000`, size `0x10000000` / 256 MiB. That is
the only generated DTS memory node that should be treated as OpenSBI/Linux
payload memory. Kernel, initrd, and DTB placement must stay inside that 256 MiB
window until the generated AP configuration changes.

The same generated DTS also contains `memory@8000000` at `0x08000000`, size
`0x10000` / 64 KiB, with `status = "disabled"`. That node is not payload RAM for
OpenSBI or Linux.

The generated Verilog/FIRRTL source includes a `SimDRAM` model with
`MEM_BASE = 0x80000000` and `MEM_SIZE = 0x10000000`. This is useful local
generated-source evidence that the AP has a Verilator DRAM model configured, but
it is not boot evidence. There is still no generated Verilator simulator
executable, OpenSBI/Linux payload placement manifest, or serial transcript
showing execution from this window.

## Phone-class 2028 target

A 2028 performance-heavy Android phone-class memory subsystem is out of scope for the current RTL. The gate in `docs/evidence/memory/uma-dram-evidence-gate.yaml` records the minimum target profile before any phone-class claim can be made:

| Requirement | Gate threshold |
| --- | ---: |
| External memory type | LPDDR5X/LPDDR6-class target |
| DRAM capacity | At least 12 GiB |
| Peak DRAM bandwidth | At least 180 GB/s |
| Sustained measured bandwidth | At least 120 GB/s on target hardware |
| Random-read p95 latency | At most 120 ns on target hardware |
| Shared system cache | At least 32 MiB |
| Protection | IOMMU/SMMU or equivalent per-device DMA isolation |
| Correctness | CPU, DMA, NPU, display, camera/ISP, and GPU/2D shared-buffer tests |

Those numbers are target gates, not evidence. Host benchmark results, simulator wall-clock numbers, or the AXI-Lite SRAM model cannot satisfy them. Valid evidence must include the real target, memory type, capacity, clocks, thermal state, process effects contract, process corner count, worst process corner, benchmark command lines, raw logs, parsed results, and contention workload details.

## Required memory hierarchy work

The next real hardware boundary needs all of the following before the memory subsystem can support Android shared buffers or AI/display throughput claims:

| Area | Required contract |
| --- | --- |
| DRAM controller and PHY | Capacity discovery, training, refresh, timing closure, error policy, and boot-time memory map evidence |
| Reset ROM and boot SRAM | Immutable reset vector, boot SRAM map, ROM-to-firmware handoff, DRAM init sequencing, and OpenSBI memory discovery transcript |
| AXI/TL interconnect | AXI4, TileLink, or equivalent fabric with bursts, IDs/source IDs, ordering domains, backpressure, atomics/cacheability attributes, and bridge tests |
| Cache hierarchy | CPU cache levels, shared system cache, allocation policy, maintenance operations, counters, and cache latency tests |
| UMA/coherency | Snoop or explicit sync policy covering CPU, DMA, NPU, display, camera/ISP, and GPU/2D clients |
| Cacheability and non-coherent DMA | Linux-visible memory attributes plus either coherent DMA proof or explicit non-coherent cache clean/invalidate/fence ABI |
| IOMMU/SMMU | Per-device DMA domains, translation faults, kernel-visible fault reporting, and negative fault-injection tests |
| Bandwidth/latency/QoS | Sustained and contended STREAM/lmbench/pointer-chase/DMA-copy reports plus display underflow and CPU latency under pressure |
| Android buffers | dma-buf or successor ABI tests proving producer-consumer freshness and fence/cache-maintenance behavior |

## Linux and Android readiness blockers

Linux/Android readiness is blocked on the following explicit memory evidence. These are dependencies for a future BSP and device tree, not capabilities in the current RTL:

| Blocker | Required evidence before readiness claim |
| --- | --- |
| Coherent DMA or explicit non-coherent ABI | Either hardware coherency for CPU and DMA-capable clients, or a documented cache-maintenance ownership protocol with positive and stale-data negative tests. |
| IOMMU/SMMU | Per-device translation domains for DMA, NPU, display, camera/ISP, and GPU/2D clients, plus authorized and unauthorized descriptor tests. |
| Page fault reporting | Kernel-visible fault records with master/client ID, IOVA, translated physical address when available, access type, permissions, syndrome/status, and recovery/reset behavior. |
| DRAM/LPDDR evidence | Real target memory type, capacity, ranks/channels, clocks, training log, refresh/timing configuration, error policy, boot-time discovered memory map, and raw logs. |
| Bandwidth, latency, and QoS | STREAM/lmbench/pointer-chase/DMA-copy results, contended Android traces, per-master counters, priority policy, display underflow counts, CPU latency under pressure, clocks, thermal state, process effects contract, process corner count, worst process corner, and 14A derated bandwidth/latency metrics. |
| CLINT/PLIC dependencies | Timer, software interrupt, and interrupt-controller windows must be reserved from DMA and described in the access map before a Linux memory map can be considered boot-ready. |

## Claim boundary

The current memory path is scaffold evidence only. It includes RTL DRAM-controller/fabric simulation evidence, but it is not real DRAM capacity or timing evidence and does not provide LPDDR/DDR PHY, training, refresh/ECC closure, cache hierarchy, UMA coherency protocol, coherent DMA, phone-class IOMMU/SMMU integration, IOMMU/SMMU translation, memory QoS, bandwidth counters, or display/NPU contention guarantees.

`docs/evidence/memory/uma-dram-evidence-gate.yaml` is the local evidence gate for this boundary. Passing that gate means the repository distinguishes the SRAM-backed DMA containment scaffold from real DRAM/UMA/coherency/IOMMU work; it must not be used as release evidence for Android shared buffers, AI throughput, display smoothness, memory bandwidth, or tapeout readiness.

## Next evidence commands

Run these in order when changing memory contracts:

```sh
make memory-uma-claim-gate
make rtl-check
make cocotb-contract
make benchmarks-dry-run
```

Only the first three can validate the current RTL scaffold. `make benchmarks-dry-run` validates parser wiring and missing-tool handling; it is not phone-class memory evidence.

For future DRAM/LPDDR integration work, the next exact commands before accepting evidence are:

```sh
make memory-uma-claim-gate
make memory-interconnect-contract-check
make chipyard-generated-linux-contract-check
make chipyard-linux-payload-check
make rtl-check
make cocotb-contract
make benchmarks-dry-run
```

The Chipyard commands inspect generated memory-map and payload preflight state only. They do not prove DRAM training, LPDDR timing, boot handoff, or Android shared-buffer correctness.
Real DRAM, PHY timing, refresh, training, ECC, cache coherency, IOMMU/SMMU, and QoS are absent from the current scaffold. There is no cache coherency, no IOMMU phone/Linux integration, and no QoS evidence for a real memory hierarchy claim. The checked-in memory-controller path now includes a full-AXI4 DRAM-controller simulation model with parameterized 2 GiB geometry and DRAMsim-derived row timing; this is a real memory controller boundary for RTL simulation, not phone-class DRAM/UMA evidence. The separate e1-chip scaffold remains SRAM-backed, and the IOMMU has a local translation-subset gate only.

Any software or product claim that depends on a real memory hierarchy must fail closed until controller, PHY, coherency, IOMMU, and QoS evidence is checked in.
