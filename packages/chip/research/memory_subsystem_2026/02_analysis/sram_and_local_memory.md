# SRAM and local memory at 14A class for the E1 NPU

Date: 2026-05-19

This document evaluates on-die memory options that can satisfy the NPU contract
in `docs/spec-db/npu-2028-target.yaml`:

- `local_sram_mib_min`: 64 MiB local NPU SRAM
- `local_sram_bandwidth_tbps_min`: 20 TB/s aggregate
- `shared_system_cache_mib_min`: 32 MiB system-level cache (SLC)
- `microarchitecture_targets.memory_system`: multi-bank local SRAM,
  compression-aware DMA, IOMMU-isolated command buffers, cache-coherent CPU
  submission, QoS for camera/display/audio/modem.
- `tiles.local_sram_mib_per_tile_min`: 4 MiB per tile, with 8-16 tiles, giving
  a 32-64 MiB lower bound just for tile-local SRAM.

## SRAM bitcell density at advanced nodes

SRAM scaling decoupled from logic scaling years ago. Public data from TSMC,
Samsung, Intel, and imec technology-plan presentations indicates the following
representative high-density (HD) SRAM bitcell areas:

| Process | HD SRAM bitcell area | Macro density (Mb/mm^2) |
| --- | ---: | ---: |
| 7 nm (TSMC N7) | ~0.027 um^2 | ~25 |
| 5 nm (TSMC N5) | ~0.021 um^2 | ~30-32 |
| 3 nm (TSMC N3E) | ~0.0199 um^2 | ~32-35 |
| 2 nm (TSMC N2 / Samsung 2 GAA) | ~0.0175-0.018 um^2 | ~38 |
| 14A class (Intel 14A / TSMC A14) | research-stage, ~10-15% over N2 | ~40-45 (target) |

These are HD bitcell numbers. Macro-level density is lower because of WL/BL
drivers, sense amps, decoders, ECC, and redundancy.

For a 64 MiB on-die NPU SRAM at 14A class:

- 64 MiB = 512 Mb. At a macro density of 40 Mb/mm^2 (optimistic 14A HD macro),
  raw cell area is ~12.8 mm^2. With macro overhead of 1.4-1.6x, the actual
  die area is ~18-21 mm^2. That is feasible inside a phone-class AP die but
  not free; it competes directly with CPU last-level cache, GPU memory, and
  system-level cache budget.
- Splitting into 16 tiles of 4 MiB each yields 16 macros of 32 Mb, which is a
  practical size for a single SRAM macro with ECC.

## SRAM bandwidth math

Target aggregate local SRAM bandwidth is 20 TB/s. Per-tile budget at 16 tiles
is `20 / 16 = 1.25 TB/s` per tile.

A multi-bank 4 MiB tile-local SRAM with 8 banks at 64-byte interface width
running at 2.5 GHz delivers `8 * 64 * 2.5e9 = 1280 GB/s = 1.28 TB/s` per tile,
which clears the per-tile target. Aggregate across 16 tiles gives 20.48 TB/s.

For 8 tiles (lower bound), each tile must deliver `20 / 8 = 2.5 TB/s`, which
means doubling either bank count or bank width to maintain the same clock,
e.g. 16 banks of 64-byte at 2.5 GHz or 8 banks of 128-byte at 2.5 GHz. This
matches the practical Buffets pattern: more, narrower banks at the same clock
reduce conflict probability, while wider banks reduce area overhead but make
conflict-free scheduling harder.

The clock target itself depends on 14A SRAM Vmin and aging; ISSCC 2024 papers
report N2-class SRAM macros operating at >2.5 GHz at Vmin in 0.6-0.65 V range.
14A is not yet published but Intel 18A/14A briefs claim incremental SRAM
improvements via PowerVia and PowerDirect (backside power). Treat the 2.5 GHz
SRAM clock as a target, not as evidence.

## Multi-bank scratchpad design (Buffets / Halide patterns)

The Buffets formalism (Pellauer et al., ISCA 2019) defines an explicit
decoupled access/execute storage block with the four primitives Push, Pop,
Read, and Update. Applied to E1:

- Each tile's 4 MiB scratchpad is partitioned into:
  - Weight Buffet (per-tile A or B operand)
  - Activation Buffet (input feature map)
  - Output / Accumulator Buffet
  - DMA Buffer (staging from L2/SLC/DRAM)
- DMA writes Push to the relevant Buffet; the systolic engine Reads from
  Buffets; the activation engine Pops outputs to the DMA buffer.
- Multi-bank organization gives one bank per stride class so weight/activation
  Read can issue in parallel with DMA Push.

Halide line-buffering applies to convolutional layers where partial-result
data is line-shaped. A tile-local line buffer of N rows by W columns reduces
re-read of upstream activations. This is a well-understood mapping (Eyeriss-v2,
NVDLA, Gemmini) and should be a Buffet partition rather than a separate
abstraction.

Multi-port designs (2R/1W, 1R/1W) are useful but pay area; for E1 the
recommendation is single-port banked SRAM with double-buffer (ping/pong)
between DMA-fill and compute-consume sides. This is the Gemmini pattern and
is the cheapest way to get bandwidth without paying for true multi-port macros.

## ECC, parity, and reliability for SRAM

The contract requires `ecc_or_parity_on_sram`. Mobile AP precedents for
accelerator SRAM:

- Parity (single-bit detect, no correct): cheapest, ~12.5% storage overhead at
  64-bit word.
- SECDED ECC (single-error-correct double-error-detect, e.g. Hamming(72,64)):
  ~12.5% storage overhead, ~3-5% area overhead for syndrome decode logic.
- DECTED (double-error-correct triple-error-detect): higher overhead, used for
  L2/L3 in server CPUs. Probably overkill for a mobile NPU.

Recommendation for E1: SECDED ECC on all tile-local SRAM and SLC. Expose
counters for corrected and uncorrected error events; tie uncorrected events to
the NPU command timeout path (per `microarchitecture_targets.reliability`).

## Shared system cache (SLC)

Contract requires >=32 MiB SLC. Mobile precedents:

- Apple A17/A18 system-level cache: 24-32 MiB.
- Snapdragon 8 Gen 3 / 8 Elite Gen 5: 12-24 MiB system cache.
- Dimensity 9300/9500: similar 10-24 MiB range.

A 32 MiB SLC at 40 Mb/mm^2 macro density is `32 * 8 = 256 Mb`, or ~6.4 mm^2 of
raw bitcell, ~10 mm^2 macro. That is achievable inside a phone-class AP die
budget if the NPU local SRAM stays at 64 MiB rather than scaling beyond.

The SLC's job is:

- Filter NPU and GPU traffic so the DRAM controller sees only cold-miss
  tail, getting effective bandwidth above raw DRAM bandwidth.
- Provide cache stash targets for CPU-to-NPU command-queue submission.
- Serve as the KV-cache home for decode-phase LLM inference. A 32 MiB SLC can
  hold a sizable fraction of LLM KV cache for small-to-medium models when
  compressed (FP8 / INT4 KV).

## MRAM, eDRAM, gain-cell alternatives

The contract is 64 MiB local SRAM. Alternatives worth tracking but not
recommended for E1 baseline:

- STT-MRAM at 22FDX, 28FDS, and 16FF nodes: ~3-4x density of SRAM, non-volatile,
  but write energy and write latency penalty (10-50 ns writes vs <1 ns SRAM).
  At 14A: GlobalFoundries 22FDX eMRAM is the most mature reference; advanced-node
  eMRAM is not yet a drop-in replacement for L2/L3 SRAM bandwidth.
- eDRAM: Intel L4 eDRAM (Crystalwell, Broadwell-C) showed ~3x SRAM density and
  ~50 GB/s class bandwidth, but die-cost penalty and lower bandwidth than SRAM
  L2/L3. eDRAM lost industry momentum after Skylake. Some accelerator papers
  argue for revival as a bandwidth-vs-cost tradeoff; for E1 NPU local memory,
  eDRAM cannot meet 1+ TB/s per tile.
- Gain-cell SRAM (2T / 3T cells): research-stage at sub-3 nm; density advantage
  vs 6T SRAM, but read-disturb and refresh add complexity. Not a 2028 mobile
  production option.

Recommendation: 6T HD SRAM at 14A for tile-local memory and SLC. Track MRAM as
a backup for always-on micro-NPU state (the always-on power budget of 20 mW
benefits from non-volatile retention).

## Compute-in-memory (CIM) and processing-in-memory (PIM)

PIM is a separate threat/opportunity surface. Mobile-relevant references:

- Samsung HBM-PIM / FIMDRAM (ISSCC 2021, ISCA 2021): function units in HBM2
  banks, FP16 multiply-add at bank level, 1.2 TFLOPS aggregated.
- SK hynix AiM (Hot Chips 2022): GDDR6-based PIM with bank-level MAC arrays,
  ~1 TOPS per device, LLM-oriented.
- UPMEM PIM-DDR: DPU per DRAM rank inside DDR4 DIMMs.
- Samsung CIM-NPU (Dimensity 9500 marketing): CIM-based "Super Efficient NPU"
  embedded in the AP. The detailed architecture is not public, but the pattern
  is SRAM-array bit-line MAC.

For E1: do not claim CIM without macro evidence and process library support.
Do reserve a placeholder for an SRAM-CIM tile mode where bit-line analog or
digital MAC operations could replace per-tile MAC arrays at sub-INT4 precision.
The compiler runtime should be agnostic to whether a tile is a conventional
systolic + SRAM or a CIM tile.

## Recommended local memory budget for E1 2028

| Block | Size | Bandwidth | Note |
| --- | ---: | ---: | --- |
| Per-tile local SRAM | 4 MiB | 1.25 TB/s | 8 banks x 64 B x 2.5 GHz, SECDED |
| Tile count | 16 | n/a | matches `tiles.count_range = [8, 16]` upper bound |
| Aggregate local NPU SRAM | 64 MiB | 20 TB/s | clears `local_sram_mib_min` and `local_sram_bandwidth_tbps_min` |
| Shared system cache (SLC) | 32 MiB | ~1.5 TB/s | shared across CPU/GPU/NPU/display |
| Always-on micro-NPU SRAM | 1-2 MiB | n/a | low-power region for wake-word and ambient sensing |
| Boot SRAM | 256 KiB | n/a | ROM-to-DRAM handoff, OpenSBI window |

Lower-bound configuration (8 tiles, 4 MiB each = 32 MiB) misses the
`local_sram_mib_min = 64` and `local_sram_bandwidth_tbps_min = 20 TB/s` if the
per-tile bandwidth does not double. The E1 implementation document
should ban any "8 tile" configuration unless the per-tile SRAM grows to
8 MiB and per-tile bandwidth grows to 2.5 TB/s.
