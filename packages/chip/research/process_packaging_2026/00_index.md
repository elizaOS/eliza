# Sub-2 nm / 14A Process, Packaging, Thermal, Reliability Research Packet

Date: 2026-05-19

This packet records a source-backed survey of 14A-class and sub-2 nm process
technology, advanced packaging, thermal and reliability physics relevant to a
2028 mobile-class AI SoC. It tracks the open work order in
`docs/spec-db/process-14a-effects.yaml` and extends, but does not duplicate,
the earlier 14A notes captured under
`research/ai_accelerator_sota/02_analysis/process_14a_sub2nm_notes.md`.

The packet is planning evidence only. Per
`docs/spec-db/process-14a-effects.yaml`, no PPA, density, yield, or sustained
TOPS/W claim may be made without a selected foundry PDK, library, signoff
manifest, and workload-correlated thermal capture.

## Files

- `01_sources/source_inventory.yaml` -- provenance, URLs, captured points,
  claim boundaries. Mirrors the schema used in
  `research/ai_accelerator_sota/01_sources/source_inventory.yaml`.
- `02_analysis/gaa_nanosheet_cfet.md` -- device architecture trajectory:
  FinFET to nanosheet/GAA, RibbonFET, forksheet, CFET, 2D-material MOSFETs,
  and Vth/variability/self-heating implications for E1 logic and SRAM.
- `02_analysis/backside_power_pdn.md` -- frontside vs backside PDN: PowerVia,
  Super Power Rail, Samsung BSPDN, imec BPR/nTSV, IR drop, decap, EM, thermal
  asymmetry, signal-routing relief, DTCO cell-height effects.
- `02_analysis/lithography_and_dtco.md` -- High-NA EUV (EXE:5000/5200) status,
  pitch trends, multi-patterning vs single-expose at A14/A10, DTCO/STCO,
  contact-over-active-gate, NanoFlex/FinFLEX, cell-height reduction.
- `02_analysis/advanced_packaging_and_chiplet.md` -- TSMC CoWoS-S/R/L,
  InFO_oS/LSI/R, SoIC-X/P, SoW; Intel EMIB/EMIB-T, Foveros/Foveros Direct;
  Samsung X-Cube, I-Cube; hybrid bonding pitch and yield trends; UCIe 1.1/2.0
  vs BoW vs OpenHBI; mobile chiplet evidence (Lunar Lake, Snapdragon X Elite,
  Apple M-series Ultra fusion).
- `02_analysis/thermal_reliability_2nm.md` -- self-heating in nanosheets,
  BTI/HCI/TDDB at GAA, EM at advanced BEOL, soft-error/FIT trends, RowHammer
  / Rowpress-class memory disturbance, mobile thermal HAL, vapor chamber
  and phone-skin thermal envelope.
- `03_implementation/process_path_for_e1.md` -- ranked recommendations keyed
  to `required_effects` entries in `docs/spec-db/process-14a-effects.yaml`
  and to existing PD, manufacturing, and signoff gates.

## Claim Boundary

Vendor press, IRDS, and conference paper claims are treated as planning
inputs only. No TSMC A14, A16, N2, N2P, Samsung SF2, Intel 18A, 14A, or
Rapidus N2 PPA, density, or yield number is asserted as proven for E1.
Numbers cited from public sources are quoted with the source ID for
traceability. Process-option selection remains
`blocked_until_foundry_pdk_and_library_selection` per the contract.

## Scope Of Extension Over Prior Notes

`process_14a_sub2nm_notes.md` covered Intel 18A/14A direction, architectural
effects (PDN, SRAM scaling, self-heating, wires, packaging-defined BW), and
proposed E1 process gates. This packet does not repeat those points. It
adds the broader 14A-class landscape (TSMC A14/A16/N2P, Samsung SF2/SF1.4,
Rapidus N2, IRDS 2024 More Moore, imec public DTCO), High-NA EUV status,
the device-architecture sweep including CFET and 2D-channel MOSFETs, BEOL
materials (Mo, Ru, air-gap, semi-damascene), 2nm SRAM macro density papers,
advanced packaging (CoWoS, Foveros, hybrid bonding pitch trends), the UCIe
1.1/2.0 vs BoW vs OpenHBI chiplet-interconnect comparison, mobile-class
chiplet evidence, mobile thermal model details (AOSP thermal HAL, vapor
chamber capacity), and reliability physics specific to GAA/nanosheet at
sub-2 nm.
