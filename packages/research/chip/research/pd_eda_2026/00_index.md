# Physical Design and Open-EDA Research Packet (2026-05-19)

Scope: cutting-edge open-source physical design, EDA, and AI-driven layout
tooling relevant to the Eliza E1 chip. This packet extends the existing
`research/alpha_chip_macro_placement/` AlphaChip work; it does not duplicate
its detail. Where the AlphaChip packet already covers a topic, this packet
cites it and adds 2025-2026 deltas.

The packet is evidence-curated reading material plus an implementation plan.
It does not claim signoff and does not modify the live PD flow. All
recommendations are ranked and traced to existing repo work orders.

## Files

- `01_sources/source_inventory.yaml` - structured registry of every external
  source (>= 45 entries), with URL, kind, last-checked date, relevance, and
  evidence link where applicable.
- `02_analysis/open_eda_flow_state_of_the_art.md` - OpenLane 2 / OpenROAD /
  Yosys / KLayout 2025-2026 state, deltas against the version family pinned
  by the current chip-package OpenLane Sky130 flow.
- `02_analysis/ai_driven_pd.md` - AlphaChip 2024 Nature update + open-source
  `circuit_training` release, CircuitNet 2.0, MaskPlace, ChiPFormer,
  WirePlanRL, AutoDMP, DREAMPlace 4, ML-CTS, ML congestion/DRC predictors.
  Designed as an extension to `research/alpha_chip_macro_placement/`.
- `02_analysis/pdk_landscape.md` - Sky130 / Sky90 / GF180 MCU / IHP130 SG13G2 /
  ASAP7 / NanGate45 viability for E1 PD smoke and future signoff.
- `02_analysis/pdn_thermal_signoff.md` - open-source IR-drop / PDN / EM /
  thermal / DRC / antenna tooling and the gaps that matter for E1.
- `03_implementation/pd_path_for_e1.md` - ranked recommendations tied to:
  - `docs/architecture-optimization/physical-power-thermal.md`
  - the OpenLane Sky130 utilization issue called out in
    `docs/three-week-prototype-workstreams.md` (771.788% utilization
    incident on the first attempted full run before the Volare PDK
    revision landed)
  - the 14A signoff gap declared in
    `docs/spec-db/process-14a-effects.yaml`.

## Existing artifacts this packet does not duplicate

- AlphaChip path:
  - `research/alpha_chip_macro_placement/06_e1_notes/openlane_full_release_2026-05-19.md`
  - `research/alpha_chip_macro_placement/06_e1_notes/softmacro_benchmark_2026-05-19.md`
- AlphaChip source inventory:
  - `research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml`
- AlphaChip SOTA review:
  - `research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md`

These remain the canonical AlphaChip references. This packet's `ai_driven_pd.md`
adds 2025-2026 deltas only.

## Cross-references in the repo

- `pd/openlane/config.sky130.json` - live OpenLane Sky130 config.
- `pd/signoff/run-manifest.schema.json` - signoff manifest schema.
- `docs/pd/` - PD evidence directory (antenna metadata, padframe, signoff
  template).
- `scripts/check_pd_signoff.py` - signoff gate.
- `docs/spec-db/process-14a-effects.yaml` - process effects contract.
- `docs/spec-db/npu-2028-target.yaml` - 2028 NPU target.

## Source policy

All entries in `source_inventory.yaml` are primary or canonical secondary
sources: GitHub release pages, arXiv papers, ICCAD/DAC/ASP-DAC/ISPD papers,
OpenROAD documentation, Efabless docs, foundry public guides (Sky130 /
GF180 / IHP130). No vendor marketing copy treated as evidence. URLs are
recorded with `last_checked: 2026-05-19` so future runs can detect drift.
