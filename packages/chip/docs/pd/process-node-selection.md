# Process Node Selection — Eliza 2028 RISC-V Phone-Class AP

This document is the canonical decision record for the production-process
target of the Eliza open RISC-V Android phone SoC. Companion machine-readable
artifacts:

- `pd/openlane/portability-index.yaml` — full PDK-to-config map
- `pd/n2p-stub/access-gate.yaml` — TSMC N2P procurement gate
- `pd/a14-stub/access-gate.yaml` — TSMC A14 procurement gate
- `pd/intel-14a-stub/access-gate.yaml` — Intel 14A procurement gate
- `pd/sf2p-stub/access-gate.yaml` — Samsung SF2P procurement gate
- `docs/spec-db/process-14a-effects.yaml` — fail-closed effects + claim contract
- `docs/evidence/process/pdk-access-gate.yaml` — top-level procurement evidence
- `docs/evidence/process/multi-pdk-closure.yaml` — per-lane closure roll-up
  (gated by `scripts/check_multi_pdk_closure.py`)

## 1. Decision

**Primary:** TSMC N2P (HVM 2H 2026, mobile-mature by 2028, frontside PDN).
**Stretch:** TSMC A14 baseline (HVM 2028, frontside).
**Strategic 2nd source:** Intel 14A (HVM 2027-2028, PowerVia BSPDN + High-NA EUV).
**Backup:** Samsung SF2P (HVM 2H 2025 / 2026, frontside).

All four are BLOCKED until foundry agreements are executed.

## 2. Rationale

### 2.1 Why N2P primary

| Axis | N2P value | Why it wins for 2028 mobile |
|---|---|---|
| HVM date | 2H 2026 | Two years of mobile-customer learning by 2028. |
| HD logic density | 313 MTr/mm² | First node since N5 where SRAM scaling resumed. |
| HD SRAM macro | 38.1 Mb/mm² | Mandatory for 16-32 MB SLC + 64 MiB NPU local SRAM envelope. |
| Power delivery | Frontside | Tractable debug, thermal modeling, DFM. BSPDN tax avoided. |
| Wafer price | ~$30-33k | Cheapest 2 nm-class entry point. |
| Customer surface | Apple A20-A21, Qualcomm, MTK | Tool / IP / PHY ecosystem co-evolves with these customers. |
| Hard-IP availability | LPDDR5X PHY shipping at 3 nm / N2 | LPDDR6 PHY in N2P/A14 vendor delivery plans. |

BSPDN A14P variant slips to 2029. Apple, Qualcomm, MediaTek, Samsung, Google
all use frontside power delivery on TSMC N3P / Samsung SF2 in 2025-2026.
BSPDN first appears at Intel 18A (Dec 2025 HVM) and TSMC A16 (2027 HVM).
TSMC's mobile A14 in 2028 is frontside-only. For a 2028 phone product,
frontside PDN is the safe call.

### 2.2 Why A14 stretch

A14 baseline (frontside) delivers +15% perf @ iso-power or -30% power
@ iso-perf vs N2 with +20% logic density, without BSPDN tax.

A14 is the realistic 2028-flagship sweet spot **if** the project has
Apple/NVIDIA-tier wafer allocation and the willing-to-pay $40-45k
per-wafer pricing. The risk is wafer allocation: A14 HVM is 2028, mobile
mid-cycle 2028-2029. Wafer allocation in 2028-Q1/Q2 will go to Apple first.

### 2.3 Why Intel 14A 2nd source

Intel courts non-Apple customers for foundry diversification. 14A is the
only path to 18A-class PowerVia BSPDN in our 2028 window and the only public
node committing to commercial High-NA EUV.

Risk-stack:
- Process unproven for mobile AP class.
- Hard-IP ecosystem (LPDDR PHY, MIPI v3, USB4) thinner than TSMC.
- BSPDN methodology cost: thermal-coupling uplift through thinned silicon
  (+5-10°C in active region), two-sided PDN extraction, two-sided test
  access, multi-quarter learning curve.
- High-NA scanner allocation reserved by ASML for Intel and TSMC; even with
  PDK access, scanner availability is its own gate.

Strategic value: BSPDN delivers ~30% IR-drop reduction and +6% Fmax in
published Intel 18A data. If our path includes a hyperscaler / government
anchor, 14A is the differentiated 2028 path.

### 2.4 Why Samsung SF2P backup

SF2P is real (Exynos 2600 ships on SF2 / SF2P 2025-2026) and has a competitive
wafer price.

Risk-stack:
- Samsung SF3 yield issues limited external customer uptake.
- SF1.4 slipped to 2028-2029, so SF2P customer mix is mostly Exynos internal.
- External hard-IP catalog at Samsung Foundry is thinner than TSMC.
- SF2Z BSPDN variant arrives 2027 and is a separate gate.

Use only if both TSMC and Intel paths are blocked.

## 3. Binary risks (foundry wall)

The four 2028 targets share a wall this project cannot move:

1. **Wafer allocation.** Apple holds >50% of TSMC N2 through 2027 Q2.
   Realistic open-project paths are MPW shuttles (effectively closed at N2),
   hyperscaler/government anchor, or partnership with an existing high-volume
   customer.
2. **NRE economics.** Single-tapeout NRE $250-400M at N2P, $300-500M at A14.
   Open-source funding models do not reach this scale.
3. **Commercial EDA.** Voltus, RedHawk-SC, PrimeTime, Tempus, Quantus, IC
   Validator, Pegasus. OpenROAD has zero certified PDKs sub-7 nm. Plan for
   $5M+/year EDA license budget.
4. **Hard-IP licenses.** LPDDR5X/6 PHY, USB4, MIPI v3, PLL, SRAM compiler.
   None exist as open IP at advanced nodes.
5. **High-NA EUV scanner allocation** (Intel 14A path only).

## 4. Die-area envelope

Reticle limit at N2 / A14 is ~858 mm² (26 × 33 mm). Mobile AP envelope:

| Item | Budget |
|---|---|
| Total die area target | 100-130 mm² |
| Reference: Apple A19 Pro on N3P | 98.68 mm² |
| Reference: Snapdragon 8 Elite Gen 5 on N3P | ~126.2 mm² |

Per-block sub-budgets at N2-class density (313 MTr/mm² HD logic, 38.1 Mb/mm²
HD SRAM macro):

| Block | N2-class area | Source |
|---|---|---|
| Ultra CPU (Kunminghu V3 8-wide-class P-core + L2) | 2.0-3.5 mm² each | A19 Pro P-core 2.97 mm² at N3P × 1/1.45 density-scale |
| Premium mid-core | 0.85 mm² each | scaled C1-Premium |
| Pro little-core | 0.25 mm² each | scaled C1-Pro |
| L3 cluster cache 8-16 MB | 4-8 mm² | 38.1 Mb/mm² assumption |
| SLC 16-32 MB | 8-16 mm² | 38.1 Mb/mm² assumption |
| NPU compute + 8 MiB local | 8-12 mm² | scaled from C1-NPU class |
| NPU SRAM 64 MiB local | infeasible as flat — hierarchy required | 1.7 mm²/MiB ≈ 110 mm² flat |
| LPDDR PHY (4×16-bit / 64-bit) | 6-10 mm² | PHY does not scale with logic |
| GPU | 6-10 mm² | Imagination or RISC-V SIMT |
| Modem / ISP / codecs / AON | 6-12 mm² combined | |

See `scripts/check_die_area_budget.py` for the executable envelope check and
`benchmarks/pd/die-shot-calibration.yaml` for the die-shot calibration source.

## 5. What this project can demonstrate today

| Capability | Today |
|---|---|
| Open-PDK PD methodology (Sky130 + GF180 + IHP SG13G2) | yes — see open lanes |
| FinFET-class PPA shape (ASAP7 predictive) | scaffold; flow exit blocked on ORFS execution |
| Advanced-node signoff (N2P / A14 / Intel 14A / SF2P) | BLOCKED until foundry agreement |
| Multi-corner STA on open Liberty | yes (SS / TT / FF + RC corners) |
| 100-200 corner LVF/SOCV signoff matrix | BLOCKED until commercial EDA seat |

## 6. Open-PDK demonstrator track

Real, manufacturable proof of methodology lives on three open PDKs:

1. **Sky130A** — 130 nm planar CMOS; primary methodology baseline; 100 ns clock.
2. **GF180MCU C-variant** — 180 nm MCU CMOS; secondary lane; 50 ns clock.
3. **IHP SG13G2** — 130 nm BiCMOS; Linux-capable demonstrator lane (Basilisk
   class, ~77 MHz ceiling).

These are real, fabbable, and run end-to-end through OpenLane 2. They prove
methodology portability but do not produce flagship-frequency numbers.

### 6.1 Selected primary prototype PDK

**Sky130A is the selected primary prototype PDK.** It is distinct from the
production-node *decision* in section 1 (TSMC N2P): N2P is the 2028 production
target and is procurement-blocked, whereas Sky130A is the PDK the flow is
actively exercised on today to prove the PD methodology produces real signoff
artifacts. Sky130A wins the prototype slot because it has the most mature open
OpenLane 2 support, the broadest open standard-cell + SRAM (OpenRAM) ecosystem,
and a proven shuttle path (SkyWater MPW, Tiny Tapeout).

Active proof: `e1_pd_smoke_top` closes clean end-to-end on Sky130A at 20 ns
(50 MHz) — DRC clean (magic + klayout), LVS clean, route DRC-free, setup and
hold met, zero slew/cap/fanout/antenna violations. Artifact:
`pd/openlane/runs/RUN_2026-05-21_10-19-23/final/metrics.json`, recorded in
`docs/evidence/process/multi-pdk-closure.yaml` and gated by
`scripts/check_multi_pdk_closure.py`. GF180MCU and IHP SG13G2 are the secondary
open lanes (configured, run-pending). Reproduce or re-prove the Sky130A flow
with `scripts/run_openlane.sh --smoke` (full release lane:
`scripts/run_openlane.sh --release`).

### 6.2 Per-foundry readiness tier

Two tiers, set by the fail-closed law. Open PDKs are *exercisable* with real
data; advanced nodes are *framework-ready, fail-closed* — wired the moment a
real NDA-gated PDK lands, with no real or faked signoff numbers in this repo.

| node_id | foundry | tier | status | what is real today |
|---|---|---|---|---|
| sky130 | SkyWater | open / exercisable | open_fabricable | **primary prototype**; e1_pd_smoke_top clean closure |
| gf180 | GlobalFoundries | open / exercisable | open_fabricable | configured lane, run-pending |
| ihp-sg13g2 | IHP | open / exercisable | open_fabricable | configured lane, run-pending (Linux-capable demonstrator) |
| asap7 | ASU (predictive) | predictive / shape-only | predictive_shape_only | FinFET PPA shapes only; never signoff, not fabricable |
| tsmc-n2p | TSMC | advanced / framework-ready | blocked_until_foundry_agreement | profile + access-gate + corner/library manifests; adapter null |
| tsmc-a14 | TSMC | advanced / framework-ready | blocked_until_foundry_agreement | profile + access-gate + corner/library manifests; adapter null |
| intel-14a | Intel | advanced / framework-ready | blocked_until_foundry_agreement | profile + access-gate + corner/library manifests; adapter null |
| samsung-sf2p | Samsung | advanced / framework-ready | blocked_until_foundry_agreement | profile + access-gate + corner/library manifests; adapter null |

Tier invariants are enforced by `scripts/check_node_profile.py` (fail-closed
law over node profiles), `scripts/check_pdk_portability.py` (portability index),
and `scripts/check_multi_pdk_closure.py` (closure-evidence consistency). An
advanced node is promoted out of the framework-ready tier only by the
section 8 quarterly decision tree, never by editing a status field directly.

## 7. Failure modes and contingencies

| If | Then |
|---|---|
| TSMC N2P access blocked | Pursue A14 / Intel 14A / SF2P in that order. |
| Intel 14A wafer allocation blocked | Pursue TSMC A14 or stay on N2P. |
| All advanced-node access blocked | Hold to 2029+ phone product; continue open-PDK methodology buildout. |
| LPDDR6 PHY not available at selected node | Fall back to LPDDR5X PHY at 9.6-10.67 Gbps. |
| Commercial EDA seat budget unavailable | Continue open methodology; no flagship tapeout possible. |
| BSPDN bring-up risk too high (Intel 14A) | Switch to TSMC A14 baseline frontside. |

## 8. Quarterly decision tree

The advanced-node lane is procurement-blocked. The project's posture is
reviewed at the end of each quarter against four binary preconditions. The
quarterly decision tree below documents the order in which those
preconditions must clear before the project can begin spending NRE.

```
Q-end decision tree
===================

1. Foundry-conversation status — is at least one of the following live?
   - TSMC OIP / NDA conversation at N2P or A14 (primary / stretch)
   - Intel Foundry Services conversation at 14A (2nd source)
   - Samsung Foundry SAFE conversation at SF2P (backup)
   ↓ no → hold; continue open-PDK and ASAP7 work; revisit next quarter
   ↓ yes → step 2

2. Hard-IP availability at the chosen node — are the following on a vendor's
   committed delivery plan with a date inside the 2028 production window?
   - LPDDR5X (mature) or LPDDR6 (preferred) PHY at the selected node
   - USB 3.2 / USB4 PHY at the selected node
   - MIPI D-PHY v3 / C-PHY v2 at the selected node
   - PLL hard IP at the selected node
   - SRAM compiler (with NanoFlex / equivalent DTCO assist)
   ↓ no → fall back one node tier (N2P ← A14, or open-PDK ← N2P) and revisit
   ↓ yes → step 3

3. Wafer-allocation realism — does the selected foundry have a wafer-window
   commitment for our tape-out + ramp inside 2028? Apple holds >50% of TSMC
   N2 through 2027 Q2; allocation must be granted in writing.
   ↓ no → hold; continue open-PDK / ASAP7; bring in anchor customer or
          DARPA-style subsidy; revisit next quarter
   ↓ yes → step 4

4. Mask-NRE + wafer-NRE budget approval — is the funding committed?
   - Mask set NRE $40-45M
   - Tapeout NRE $250-500M
   - Commercial EDA seat budget $5M+/yr
   - Hard-IP license budget
   ↓ no → hold; the project does not own a tape-out window without funding
   ↓ yes → unblock the selected lane: flip `access_gate` to `unblocked`,
           land the foundry NDA / license artifacts under
           `docs/evidence/process/`, and remove the BLOCKED label from the
           portability index.
```

The decision tree is fail-closed: every step is binary, every step blocks
the next, and every "no" path keeps the project on the open-PDK methodology
track instead of pretending the BLOCKED lane is live.

## 9. Sources

- `docs/architecture-optimization/sota-2028/process-nodes.md` — full SOTA report
- TSMC public process-node plan (Tom's Hardware): A12 / A13 / N2U; A16 → 2027; A14 → 2028
- TSMC Tech Symposium 2025: A14 +15% perf @ iso-power vs N2
- Intel Foundry process-node plan: 18A-PT (3D stacking), 14A (BSPDN + High-NA)
- imec backside-PDN DTCO studies
- IEEE IRDS 2024 More Moore edition
- TechPowerUp A19 Pro die-shot (98.68 mm²)
- Notebookcheck S8E5 die-shot (~126.2 mm²)
- WikiChip N3 SRAM stall + N2 38.1 Mb/mm² resume
- Synopsys / Cadence / Rambus LPDDR PHY delivery plans
