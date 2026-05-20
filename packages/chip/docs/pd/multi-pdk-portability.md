# Multi-PDK Portability — Methodology

The Eliza chip targets one production node (TSMC N2P primary, A14 stretch,
Intel 14A 2nd source, Samsung SF2P backup) but runs PD across a fleet of
open PDKs so that the methodology, RTL, constraints, and signoff harness are
portable before $250M-$500M of NRE is committed to one foundry.

This document is the methodology contract. The executable side is:

- `pd/openlane/portability-index.yaml` — config-to-PDK mapping
- `scripts/check_pdk_portability.py` — verifies every config has matching
  library + corner manifest and that advanced-node lanes remain blocked
- `scripts/project_ppa_to_n2p.py` — applies published vendor scaling factors
  to open-PDK / ASAP7 PPA shapes to project N2P / A14 envelope
- `docs/evidence/process/multi-pdk-closure.yaml` — closure evidence per PDK

## 1. Why multi-PDK

1. **Methodology de-risk.** Same RTL, swap PDK config, run end-to-end. If the
   flow breaks at GF180 but works at Sky130, the bug is PDK-coupled and would
   bite us harder at N2P.
2. **Closure-mode coverage.** Sky130 is 5-metal planar 130 nm. GF180MCU is
   5-metal MCU CMOS. IHP SG13G2 is 5+2-metal BiCMOS. ASAP7 is 9-metal predictive
   FinFET. Running across all four exercises different routing-layer counts,
   different cell heights, different timing scales, different DRC styles.
3. **Fail-closed economics.** Open PDKs produce real (cheap) evidence. ASAP7
   produces shape (also cheap). N2P / A14 / Intel 14A / SF2P produce no
   evidence until foundry agreement; the cost gate is binary.
4. **Open-shuttle path.** IHP SG13G2 is the active open shuttle vehicle via
   SwissChips / Tiny Tapeout after Efabless ChipIgnite shut down in March 2025.

## 2. What is PDK-agnostic vs PDK-locked

| Stage | PDK-agnostic | PDK-locked |
|---|---|---|
| RTL elaboration (Yosys read) | yes | — |
| Yosys synthesis pre-tech-map | yes | — |
| Yosys tech-map | — | yes (cell library) |
| ABC mapping | — | yes (Liberty per corner) |
| Floor-plan utilization target | mostly | tile-size / utilization sweet-spot differs per PDK |
| Macro placement (DREAMPlace / AlphaChip / OpenROAD) | mostly | — (algorithm is PDK-agnostic; cost weights tune per PDK) |
| Global / detailed route | — | yes (DRC, layer stack, via rules) |
| Clock tree (CCOpt / TritonCTS / mesh-hybrid) | algorithm yes, cell library no | — |
| STA | structurally yes | Liberty + RC per PDK |
| DRC | — | yes |
| LVS | — | yes |
| Antenna | — | yes |
| Density / fill | — | yes |
| PDN extraction | — | yes (frontside vs BSPDN especially) |

So the rule is: synthesize the same RTL against every PDK, **expect different
numbers**, expect identical pass/fail shape on the methodology checks.

## 3. Portability index

`pd/openlane/portability-index.yaml` is the canonical map. Each entry pins:

- the OpenLane / ORFS config path
- the node class (130 nm planar, 180 nm MCU, 130 nm BiCMOS, 7 nm predictive,
  2 nm GAA nanosheet, etc.)
- whether the PDK is open or commercial-NDA
- whether the PDK is fabricable
- the standard-cell library + version
- the metal stack + max routing layer
- the clock-period target + clock-target-MHz
- the SRAM compiler name
- the library + corner manifest paths
- the role (primary methodology baseline / Linux-capable demonstrator /
  primary production target / stretch / 2nd source / backup)
- the access gate (`open_no_gate` or `blocked_until_foundry_agreement`)

`scripts/check_pdk_portability.py` walks the index and verifies:

1. Every entry's config file exists.
2. Every entry's library_manifest + corner_manifest exists.
3. Every advanced-node entry has `access_gate: blocked_until_foundry_agreement`.
4. Every open-PDK entry can compile (DRC / LVS / route) — when an `evidence`
   pointer to a closure record exists.
5. The portability index passes the schema check.

## 4. Methodology contract per PDK

### 4.1 Sky130A — primary methodology baseline

- Status: real, fabricable, open.
- Clock target: 100 ns (10 MHz) per `pd/openlane/config.sky130.json`.
- Closure status: latest `pd/openlane/runs/RUN_2026-05-19_05-08-54` is
  clean DRC + LVS at 142,274 std-cells, 3.24 mm² die, 0 macros.
  Hold + slew + cap violations open — see
  `pd/signoff/manifest.yaml`.
- Evidence class: real open PDK methodology evidence.

### 4.2 GF180MCU — secondary lane

- Status: real, fabricable, open (GlobalFoundries 180 nm MCU C variant).
- Clock target: 50 ns (20 MHz).
- Evidence class: real open PDK methodology evidence.
- Use case: pure-CMOS cross-check vs Sky130. Different cell-height (7-track
  5 V), different IO ring (3.3V / 5V), different rail definitions.

### 4.3 IHP SG13G2 — Linux-capable demonstrator lane

- Status: real, fabricable, open (IHP-GmbH 130 nm BiCMOS).
- Clock target: 13 ns (~77 MHz; Basilisk ceiling).
- Evidence class: real open PDK methodology evidence.
- Use case: Linux-capable demonstrator. Basilisk demonstrated Linux-capable
  RISC-V SoC closure at SG13G2 ~77 MHz, which is the active open-shuttle
  high-water mark. BiCMOS gives analog blocks we cannot get on
  Sky130 / GF180.

### 4.4 ASAP7 predictive — FinFET-class shape

- Status: predictive academic PDK, not manufacturable.
- Clock target: 250 ps for big core (4 GHz), 500 ps for NPU (2 GHz),
  333 ps for SLC (3 GHz).
- Evidence class: predictive FinFET shape only, never signoff.
- Use case: produce shape per block, then project to N2P via
  `scripts/project_ppa_to_n2p.py`.

### 4.5 TSMC N2P / A14 / Intel 14A / Samsung SF2P — BLOCKED

- Status: blocked until foundry agreement.
- Evidence class: procurement-blocked, no artifacts.
- See `pd/n2p-stub/`, `pd/a14-stub/`, `pd/intel-14a-stub/`, `pd/sf2p-stub/`.

## 5. Portability check workflow

```sh
make pdk-portability-check   # verify every config has manifests + access gate + macro cross-ref
make pdk-portability-test    # unit tests for the portability checker
make pdk-access-gate         # advanced-node procurement evidence (fail-closed)
make ppa-projection          # project open / ASAP7 PPA to N2P / A14 / Intel 14A / SF2P
make die-area-budget-check   # 100-130 mm² envelope cross-check vs die-shot cohort
```

Each command writes a structured report to `docs/evidence/process/`. Reports
include:

- `evidence_class` (real open-pdk / predictive shape / procurement-blocked)
- the list of pass / blocked entries with reasons
- next-step commands

The portability checker cross-references `pd/macros/manifest.yaml` (owned by
the PD agent): every Sky130 and IHP SG13G2 library manifest must declare the
same hard-macro set the PD agent has declared. Drift on either side fails the
gate.

The PPA projection script runs a 4096-sample Monte Carlo over the
public-disclosure 1-sigma bands documented in
`docs/evidence/process/ppa-projection.yaml`, producing p10 / p50 / p90 bands
per target node (N2P / A14 / Intel 14A / Samsung SF2P). Outputs remain
`projection_only_never_signoff`.

## 6. Where portability ends

Portability ends at: (a) the LPDDR PHY (no open PHY exists at any node;
license required from Synopsys / Cadence / Rambus); (b) the SRAM compiler at
advanced nodes (foundry-only); (c) the antenna / dummy-fill / density rules
at advanced nodes; (d) the commercial signoff EDA flow.

Portability is **methodology and RTL**, not silicon-equivalence. A clean
Sky130 closure does not prove a clean N2P closure. It proves that the project
can drive a real PDK-locked flow end-to-end and is therefore competent to
operate a commercial flow when seats are bought.
