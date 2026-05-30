# Cache hierarchy contract

This document is the contract for the executable cache-hierarchy RTL in
`rtl/cache/`. It complements `docs/arch/cpu-subsystem.md`,
`docs/arch/memory-subsystem.md`, and `docs/arch/interconnect.md`. The
benchmarking and BLOCKED-claim contract for this work lives at
`docs/evidence/cache/cache-evidence-gate.yaml` and is enforced by
`scripts/check_cache_hierarchy.py`.

The repository contains synthesizable RTL for the on-die SRAM hierarchy
that hides DRAM latency. This RTL provides a four-level hierarchy (L1I,
L1D, private L2, shared L3) plus a multi-bank SLC and a BDI compression
path, all sized to the 2028 phone-class minimums. SoC-top phone
integration, Linux/Android execution, LPDDR PHY/training, and real target
bandwidth evidence remain outside this local cache RTL contract.

## Geometry

| Level | Size | Ways | Line | Sets / bank | Banks | Latency (cyc) | Notes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| L1I  | 64 KB | 8  | 64 B | 128 | 1 | 4 (load-use) | Parity per line, FDIP prefetch |
| L1D  | 64 KB | 8  | 64 B | 128 | 8 | 4 (load-use) | SECDED ECC, 2R/2W banked |
| L2   | 1 MB  | 8  | 64 B | 2048 | 1 | 12 | MESI, inclusive of L1I tags, PTW data port |
| L3   | 8 MB  | 16 | 64 B | 8192 | 4 | ~25 | MESI directory, DRRIP/Hawkeye/Mockingjay |
| SLC  | 16 MB | 16 | 64 B | 16384 | 4 | ~50 | Per-client QoS, way-partition, BDI compression |

Each size and bank count is a module parameter (`SIZE_BYTES`, `WAYS`,
`LINE_BYTES`, `BANKS`). Halving the L2 to 512 KB or shrinking the SLC to
8 MB for a smaller variant is one parameter override.

2028 phone-class minimums enforced by the claim gate:

- L1I ≥ 32 KB
- L1D ≥ 32 KB
- L2 ≥ 256 KB
- L3 ≥ 4 MB
- SLC ≥ 8 MB

Stretch targets (Apple-class) are not gated:

- L1I/L1D 96 KB
- L2 2 MB on the Ultra big core
- L3 16 MB
- SLC 32 MB

## Files

```
rtl/cache/
  cache_pkg.sv                 shared parameters and helpers
  ftq_to_l1i_pkg.sv            BPU FTQ -> L1I prefetch interface
  lsu_to_l1d_pkg.sv            OoO LSU -> L1D 2R/2W interface
  l1i/e1_l1i_cache.sv          read-only L1I with FDIP prefetch
  l1i/e1_l1i_dual_miss_to_l2.sv scalar + lane-1 L1I miss bridge to L2
  l1d/e1_l1d_cache.sv          2R/2W L1D with SECDED + MESI
  l2/e1_l2_cache.sv            private L2 with PTW port
  l3/e1_l3_cache.sv            shared L3 with directory + DRRIP
  slc/e1_slc.sv                SLC with QoS + BDI + way partition
  prefetch/e1_berti_prefetcher.sv
  prefetch/e1_fdip_l1i_prefetcher.sv
  prefetch/e1_stride_prefetcher.sv
  prefetch/e1_best_offset_prefetcher.sv
  prefetch/e1_spp_prefetcher.sv
  prefetch/e1_ipcp_prefetcher.sv
  prefetch/e1_pythia_stub.sv          BLOCKED stub; real RTL is follow-on
  replacement/e1_drrip.sv             cheap MVP
  replacement/e1_hawkeye.sv           fallback option
  replacement/e1_mockingjay.sv        primary academic-quality port
  compression/e1_bdi_compress.sv
  compression/e1_bdi_decompress.sv
  coherence/tl_c_to_chi_bridge.sv     TL-C plane -> AXI4/CHI south boundary
```

## Coordination interfaces

### BPU ↔ L1I

The BPU runs a decoupled Fetch Target Queue ahead of the IFU. FTQ writes
prefetch requests; the L1I consumes them.

```
ftq_to_l1i_pkg::ftq_prefetch_req_t = {
  paddr_line[39:0],      // 64 B-aligned
  confidence[2:0],       // 0..7
  branch_target          // 1 if FTQ entry originates from a branch target
}
```

Single-cycle handshake. The L1I drops in-flight prefetches on `ifu_flush`.
In-progress demand line fills are not aborted by flush. The BPU agent owns
the FTQ producer side and never modifies the L1I; the cache agent owns the
consumer side and never modifies the FTQ. Both sides `import` the same
package.

Widened target-block demand traffic uses the optional lane-1 IFU demand
inputs on `e1_l1i_cache`. When either the scalar lane or lane 1 misses,
`e1_l1i_dual_miss_to_l2` arbitrates the two miss pipes onto the existing L2
L1I acquire channel and demuxes the returned 64 B line into the scalar or
lane-1 refill beat stream. Scalar demand has priority on a simultaneous
miss; lane 1 remains ordered and retries once the scalar fill completes.
Focused cocotb coverage exercises lane-1 refill demux, scalar priority, and
flush of an outstanding lane transaction.

### LSU ↔ L1D

```
lsu_to_l1d_pkg::lsu_l1d_req_t = {
  paddr[39:0], size[2:0], is_load, wdata[127:0], wstrb[15:0], tag[7:0]
}
lsu_to_l1d_pkg::lsu_l1d_resp_t = {
  rdata[127:0], tag[7:0], ack, replay, ecc_uncorrectable
}
```

Two request ports (p0, p1). Bank conflict on the same paddr[6:4] causes p1
to replay. ECC double-bit errors surface as `ecc_uncorrectable=1` plus a
replay; single-bit errors are corrected silently with an
`hpm_l1d_ecc_corr` pulse.

### L2 ↔ L3 ↔ SLC ↔ DRAM

TileLink TL-C-class messages flow inside the cluster (L1↔L2↔L3↔SLC). At
the SLC↔DRAM boundary, `tl_c_to_chi_bridge` converts TL acquire/release to
AXI4 AR/AW/W/R/B with 8-byte beats. The memory agent owns everything south
of that bridge.

## Coherence

- Protocol: MESI on TileLink TL-C inside the cluster.
- Directory: distributed at L3, snoop filter per slice, full inclusion of
  L2 tags.
- Probes: `MESI_S` (downgrade M→S, write back dirty) and `MESI_I`
  (invalidate, write back dirty if M).
- L1I never holds dirty data; on `MESI_I` probes it invalidates and acks
  without writeback.

## QoS at SLC

`e1_cache_pkg::qos_class_e` defines eight classes; lower numeric value
wins. The SLC contains QoS-class plumbing and programmable window fields,
but saturation service guarantees are not claimed until a dedicated SLC
QoS test and contended SoC-level or target evidence are on file. Way
allocation per QoS class is programmable via `way_alloc_mask`. Way shutoff
for DVFS is programmable per bank via `way_enable_mask`.

| Class | Numeric | Allowed clients |
| ---: | ---: | --- |
| `QOS_DISPLAY_RT` | 0 | Display real-time |
| `QOS_CAMERA_ISP` | 1 | Camera, ISP |
| `QOS_CPU_FG` | 2 | CPU foreground threads |
| `QOS_CPU_BG` | 3 | CPU background, writebacks |
| `QOS_NPU` | 4 | NPU tensor streaming |
| `QOS_GPU` | 5 | GPU / 2D rasterizer |
| `QOS_DMA_BULK` | 6 | Peripheral DMA, USB, NVMe |
| `QOS_LOW` | 7 | Background / non-time-sensitive |

## BDI compression at SLC

Five compressed forms are supported (Pekhimenko et al., PACT'12):

| Form | Encoding | Payload | Bytes vs 64 B line |
| --- | --- | --- | ---: |
| `BDI_ZERO`   | all-zero line | none | 0 |
| `BDI_REPEAT` | 8 B base repeated | 8 B | 8 |
| `BDI_B8D1`   | 8 B base + 8 × 1 B signed delta | 16 B | 16 |
| `BDI_B8D2`   | 8 B base + 8 × 2 B signed delta | 24 B | 24 |
| `BDI_NONE`   | uncompressed | 64 B | 64 |

L1 and L2 do not compress (latency tax). Only SLC.

## Replacement

DRRIP is the default for L3 and SLC. The L3 module parameter
`REPLACEMENT_POLICY` selects the policy and the cache delegates victim
selection and access training to a dedicated replacement sub-module — the
choice is single-source-of-truth, not an inline reimplementation:

| `REPLACEMENT_POLICY` | Policy     | Delegated module     |
| -------------------- | ---------- | -------------------- |
| `2'd0` (default)     | DRRIP      | `e1_drrip`           |
| `2'd1`               | Hawkeye    | `e1_hawkeye`         |
| `2'd2`               | Mockingjay | `e1_mockingjay_prod` |
| `2'd3`               | LRU        | in-module tree-PLRU  |

Policies 0–2 instantiate their real sub-modules over the flattened
`{bank,set}` index space; each maintains its own way-state and the L3 FSM
emits only the hit/install access events the sub-modules train on. The L3
directory carries no PC, so the PC-keyed structures in Hawkeye/Mockingjay
see a constant PC; Mockingjay's line-address-keyed STT still trains on the
real `(set,tag)`. `verify/cocotb/cache/test_l3_replacement_distinct.py`
proves the three delegated policies are live (each reacts to its own
training) and pairwise-distinct (they do not collapse onto one another or
onto tree-PLRU). Mockingjay is the primary academic-quality port,
validated functionally against the LRU reference path in
`verify/cocotb/cache/test_mockingjay_accuracy.py`. Productized DPC-3/IPC
evidence requires follow-on work; see
`docs/evidence/cache/cache-evidence-gate.yaml`.

## HPM events

The cache hierarchy emits 1-cycle pulses on `hpm_*` signals. The CPU's
HPM aggregator owns the counter registers. Event codes are declared in
`e1_cache_pkg::HPM_*` and reserved for the cache hierarchy at the
Zihpm-class boundary.

| Code | Event |
| ---: | --- |
| 0 | L1I access |
| 1 | L1I miss |
| 2 | L1I useful prefetch |
| 3 | L1D access |
| 4 | L1D miss |
| 5 | L1D useful prefetch |
| 6 | L1D ECC single-bit corrected |
| 7 | L1D ECC double-bit uncorrectable |
| 8 | L2 access |
| 9 | L2 miss |
| 10 | L2 prefetch |
| 11 | L3 access |
| 12 | L3 miss |
| 13 | L3 snoop hit (probe forwarded) |
| 14 | L3 writeback |
| 15 | SLC access |
| 16 | SLC miss |
| 17 | SLC way shutoff active |
| 18 | SLC BDI compression hit |
| 19 | SLC display realtime hold |

## Verification

| Target | Coverage |
| --- | --- |
| `make rtl-check`               | Verilator lint of every cache module |
| `make cocotb-cache-coherence`  | MESI transitions, single-writer-multi-reader |
| `make champsim-prefetch-sweep` | DPC-3 sweep of upstream ChampSim prefetchers (no/next_line/ip_stride/spp_dev/va_ampm_lite) plus in-tree 2024-12 module-API ports of the CRC-style drop-ins (Berti/IPCP/Bingo/BOP/Pythia) under `external/ChampSim/prefetcher/<name>/`. evidence_class=champsim_dpc3_traces_only; do NOT promote to phone-class without silicon or full-system-simulator evidence. |
| `make mockingjay-vs-lru-sweep` | DPC-3 LRU baseline + bundled replacement deltas (drrip/ship/srrip). Productized Hawkeye/Mockingjay IPC evidence remains BLOCKED until current ports and traces are complete. evidence_class=champsim_dpc3_traces_only |
| `make cocotb-cache-mockingjay-accuracy` | Mockingjay-prod RTL hit-rate vs LRU on synthetic scan+reuse stream (current local cocotb evidence is +8.76 percentage points / +17.50% relative, above the +10% relative threshold; this is RTL synthetic evidence, not DPC-3/product phone evidence; see mockingjay_cocotb_synthetic_report.json) |
| `make lmbench-cache-curve`     | lat_mem_rd canonical L1/L2/L3/SLC/DRAM curve (currently BLOCKED pending RV64 lmbench source/toolchain and target metadata; real-target evidence remains BLOCKED) |
| `make cache-hierarchy-claim-gate` | Static gate enforcing 2028 minimums and blocked-claim discipline |

## Claim boundary

This RTL is a synthesizable, Verilator-runnable cache hierarchy for
pre-silicon evaluation, simulation, and ChampSim/gem5 cross-checking. It
is not silicon, it is not measured on a real target, and it is not
evidence of phone-class IPC or latency. Phone-class claims remain
BLOCKED until the gate at `docs/evidence/cache/cache-evidence-gate.yaml`
records measured evidence from real silicon or a full-system simulator
with traceable provenance.

`make cache-hierarchy-claim-gate` enforces this boundary. Any addition
of a phone-class claim must replace the corresponding BLOCKED entry
with a measured evidence artifact; the gate fails closed otherwise.
