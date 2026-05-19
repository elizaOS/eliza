# Compute-in-memory and near-memory acceleration for a phone NPU

Date: 2026-05-19

This file evaluates the CIM / PIM landscape against a 14A phone NPU and
the existing E1 microarchitecture, where `microarchitecture_targets`
already lists `multi_bank_local_sram` and `compression_aware_dma` but
does not commit to a CIM substrate.

The reference survey is `cim_landscape_survey` (arXiv 2401.14428), which
classifies CIM/CNM into:

- digital SRAM CIM (in-bit-cell or in-bit-line MAC),
- analog SRAM / capacitor CIM,
- ReRAM / PCM / MRAM analog CIM,
- DRAM-PIM at HBM and standard-DDR levels.

## Which CIM variants are credible for a 14A phone

### Digital SRAM CIM — primary candidate

- **TSMC 3 nm 6T SRAM digital CIM macro** (`tsmc_dcim_isscc2024`) is a
  foundry-shipping IP point. INT12 x INT12 in a single cycle; macro size
  amenable to integration in a tile-local scratchpad.
- **Google's TPU CIM exploration** (`cim_tpu_paper`) shows digital SRAM
  CIM as a near drop-in MXU substitute with measurable energy savings.
- **SynDCIM** (`syndcim_paper`) is a digital CIM compiler if a custom
  macro becomes preferable to a foundry IP.

For E1, digital SRAM CIM is the only CIM variant that is simultaneously:

- compatible with the existing tile + scratchpad design
  (`docs/arch/npu-microarch.md`),
- compatible with INT8 / INT4 / INT2 / FP8 precision (digital MAC is
  precision-agnostic by construction),
- available as foundry IP today, and
- testable with conventional digital signoff.

### Analog SRAM / capacitor CIM — possible IP partner

- **EnCharge AI** (`encharge_ieee_spectrum`, `encharge_en100_dcd`)
  claims >40 TOPS/W INT8 with capacitor-based analog CIM, ~150 TOPS at
  1 W in EN100 form factors.
- **Mythic** (the historical incumbent) demonstrated production analog
  CIM in 40 nm and 28 nm; commercial trajectory has been bumpy.

Analog CIM has the highest claimed perf/W but ships with three serious
risks:

1. ADC area and energy dominate at higher precision (INT8 and beyond).
2. Process portability is poor; an analog CIM macro is essentially a
   per-node redesign.
3. Test methodology is non-standard; coverage is harder to argue at
   automotive / phone production scale.

For E1 specifically, analog CIM is reasonable as an **optional add-on
tile** (e.g. always-on micro-NPU at the 20 mW envelope where its perf/W
matters most) but is not the primary tile.

### DRAM-side PIM — not in the phone NPU envelope today

- **Samsung HBM-PIM (FIMDRAM)** (`hbm_pim_samsung`) — 16 SIMD engines per
  bank, doubled effective accelerator throughput in vendor benchmarks.
  Targets datacenter HBM, not phone LPDDR.
- **SK hynix AiM** (`skhynix_aim`) — bank-level compute in GDDR6 form
  factor.
- **UPMEM** (`upmem_hotchips`) — general-purpose PIM at DDR4-DIMM scale;
  8 small DPUs per chip, 64 MB MRAM per DPU.
- **PIM-MMU** (`pim_mmu_paper`) — MMU for commercial PIM dataflow,
  MICRO 2024.

For a phone in 2028, an LPDDR5X or LPDDR6 PIM standard would be required
to access this technique on the device. JEDEC has not yet standardized
LPDDR-PIM, so this is a watch item, not a design dependency. The MediaTek
NPU 990 CIM block (`mediatek_dimensity_9500_product`) appears to be
inside the SoC, not in the DRAM die, which is the realistic 2028 phone
position.

### ReRAM / PCM / MRAM — defer

ReRAM CIM is an active research area but lacks foundry-grade IP at 14A.
Defer to a research watch list until at least one of the major foundries
ships a production ReRAM macro alongside its SRAM offerings.

## Where CIM helps E1 most

The E1 power envelope is 4.5 W sustained / 8 W burst at 18 TOPS/W INT8
sustained. The largest energy components in a conventional NPU are:

1. SRAM read for weights (10..20% of total at fp16 / int8, more at int4
   if no compression).
2. MAC array energy.
3. DRAM access for weights and KV cache.

Digital SRAM CIM directly attacks (1) by performing the MAC inside the
weight SRAM array. Per `cim_tpu_paper`, this can shift the energy split
significantly enough to make a measurable difference in sustained
TOPS/W without forcing an architectural rewrite.

CIM does **not** materially help with KV-cache decode bandwidth or
descriptor / DMA overhead. Those are addressed by MLA, paged attention,
and KV quantization (see `02_analysis/sparsity_and_attention.md`).

## Recommended E1 position

High confidence:

- Treat **digital SRAM CIM** as the only CIM variant in scope for the
  L5 phone-class envelope. Plan the L3 / L4 tile so the SRAM weight
  banks can be optionally replaced with a digital CIM macro without
  changing the tile ABI. This means: weight read latency and
  per-element MAC contract must match either a conventional SRAM tile
  or a digital CIM macro.
- Track foundry CIM IP availability through 14A node specifically. The
  TSMC 3 nm result (`tsmc_dcim_isscc2024`) is the bellwether.

Medium confidence:

- Carve out an optional always-on micro-NPU slot that could accept an
  analog CIM IP block at the 20 mW envelope. Do not commit to a vendor.

Lower confidence (defer):

- LPDDR-PIM: monitor JEDEC LPDDR6 evolution and Samsung / SK hynix
  partnerships, but do not bake into the spec.
- ReRAM / PCM / MRAM CIM: research watch only.

## Caveat on vendor claims

Every TOPS/W number in the CIM space is a vendor or research claim.
Analog CIM claims in particular tend to apply only to a narrow operating
point (specific precision, specific batch size, specific layer size). E1
evidence files must measure CIM benefit on the same workload set as the
non-CIM baseline before any production claim is allowed.
