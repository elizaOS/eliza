# Coherency, NoC, and interconnect in open RISC-V ecosystems

Date: 2026-05-19

E1's current bus boundary (`docs/arch/cpu-subsystem.md`) is a single 32-bit
AXI-Lite manager from the tiny CPU scaffold. Linux-class operation requires
the selected Chipyard Rocket path's TileLink + AXI fabric. Phone-class AP
operation requires a real coherent interconnect with directory or
snoop-based coherence and a coherent NPU/DMA path. This note maps the
open-ecosystem options.

## Protocol landscape

| Protocol | Family | Source | Coherence | Where it shows up |
| --- | --- | --- | --- | --- |
| **TileLink-UL** | open | CHIPS Alliance | none (uncached) | Chipyard peripheral bus, MMIO |
| **TileLink-UH** | open | CHIPS Alliance | none (no atomic coherence) | uncached heavy traffic |
| **TileLink-C** | open | CHIPS Alliance | branch/trunk/tip MOESI-style | Rocket, BOOM, XiangShan via HuanCun |
| **AXI4** | open spec | Arm | none (memory ordering only) | bus boundary into DRAM, peripheral interconnect |
| **AXI4 + ACE** | open spec | Arm | MOESI snoop-based | not used in open RV cores |
| **AMBA CHI** | open spec | Arm | directory-based | not used in open RV cores |
| **CCIX** | open spec | CCIX Consortium | PCIe-coherent | deprecated, superseded by CXL |
| **CXL 3.0** | open spec | CXL Consortium | host coherent | future system-level use only |
| **BedRock** | open | BlackParrot (UW/BU) | directory MOESI | BlackParrot tile mesh |
| **HuanCun** | open | OpenXiangShan | directory + TileLink-C | KunMingHu inclusive L2/L3 |
| **P-Mesh** | open | Princeton OpenPiton | directory | OpenPiton tiles with Ariane/CVA6 or OpenSPARC |

## NoC generators

| Generator | License | Topology | Coherence overlay | Fit for E1 |
| --- | --- | --- | --- | --- |
| **Constellation** | BSD-3-Clause | mesh, ring, torus, custom | TileLink, AXI | First-class fit, Chipyard-native. |
| **OpenPiton P-Mesh** | BSD-3-Clause / Solderpad | mesh tiles | directory cache coherence | Mature, large area cost. |
| **ESP NoC (Columbia)** | Apache-2.0 | multi-plane mesh | accelerator sockets, Linux coherent overlay | Strong accelerator integration story. |
| **PULP AXI Xbar / NoC** | Apache-2.0 / Solderpad | AXI4 crossbar + AXI NoC | none (AXI semantics) | Used in Cheshire/Carfield. |
| **DUH / DesignWare XBAR** | proprietary | AXI | none | Out of scope for open path. |

## DMA + NPU coherence

The work order in `docs/architecture-optimization/compute-silicon.md`
designates DMA as the first shared-memory primitive and explicitly defers
coherent DMA claims:

> "Keep DMA as the first shared-memory performance primitive and prove
> ordering, backpressure, and error handling. No coherent DMA claim until
> memory-system verification exists."

The open precedent for coherent accelerator DMA is:

- **Chipyard + Gemmini.** Gemmini connects to the L2 via TileLink-C and
  uses cache-coherent accesses for scratchpad fills.
- **ESP NoC.** Accelerators are first-class sockets with a coherence
  policy (LLC-coherent / non-coherent / fully coherent) selectable per
  accelerator.
- **OpenPiton + NVDLA.** Princeton paper integrated NVDLA via P-Mesh with
  cache-coherent DMA.

For E1, the practical path is:

1. NPU starts with non-coherent DMA over an AXI/TileLink-UH path with
   explicit OS-managed cache flush primitives (this is what
   `compute-silicon.md` P0 already requires).
2. Coherent DMA over TileLink-C is the natural next gate once Rocket
   bring-up is past Linux smoke and the L2 cache has a verified coherence
   contract.
3. Snoop-based or directory-based system-level coherence (CHI-style) is
   deferred to a phone-class AP plan and is out of scope until
   `docs/spec-db/cpu-2028-target.yaml` exists.

## Cache management Linux/OpenSBI hooks

Open RV cores expose cache maintenance through one of three pathways:

1. **Standard `Zicbom` / `Zicbop` / `Zicboz` (cache block management).**
   Ratified. Used by Linux for DMA cache flush primitives. Required for
   Android RV.
2. **OpenSBI SBI_EXT_CACHE.** SBI service used by older RV Linux kernels
   when Zicb* was not ratified.
3. **Vendor-defined CSRs / MMIO.** XuanTie cores have private cache CSRs;
   Linux upstream has dropped explicit support for these in favor of the
   standard Zicb* path.

E1's selected Chipyard Rocket path implements Zicbom on the L2; the
spec-db should pin this once the generator manifest exposes it.

## Memory ordering

| Spec | Status | Notes |
| --- | --- | --- |
| **RVWMO** | ratified | RISC-V Weak Memory Ordering, the application memory model. |
| **Ztso** | optional | Total Store Order; SiFive cores implement it. Useful for compatibility with Arm-class single-writer code. |
| **Sscofpmf** | ratified | Performance counter overflow filter; required for Linux `perf`. |
| **Svinval** | ratified | TLB shootdown primitives; required for SMP Linux scaling. |
| **Svnapot** | ratified | NAPOT page-size hints; reduces TLB pressure. |

## Recommendation for Eliza E1

1. Hold the TileLink + Chipyard interconnect stack as the selected fabric.
   The Constellation NoC generator is the candidate for any NoC growth
   inside Chipyard.
2. Bind cache maintenance to **Zicbom + Zicbop + Zicboz**, not vendor
   CSRs.
3. Bind memory ordering claims to **RVWMO**. Ztso is not required for
   Android RV and adds verification cost.
4. Track CHI-B and AMBA CHI as future research only; no open RV core
   implements them today.
5. Track ESP NoC as the second-best generator if E1 ever exits Chipyard.
6. Add cache/coherency contract fields to the future
   `docs/spec-db/cpu-2028-target.yaml`: protocol (TileLink-C), coherence
   class (directory vs snoop), line size, L1/L2/LLC capacity, NoC
   topology, NoC width, coherent-DMA toggle, and Zicbom support flag.
