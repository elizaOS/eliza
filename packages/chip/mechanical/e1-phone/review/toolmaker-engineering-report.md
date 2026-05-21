# E1 Phone Toolmaker Engineering Report

Owner: Shenzhen Yuyao Tooling Co. (YYT) | Reviewer: E1 mechanical lead | Date: 2026-04-22

Backing document for the entries in `toolmaker-signoff-response-template.csv` and the `toolmaker-signoff-package` gate. Captures the steel selection, surface finish, draft, parting strategy, ejector layout, runner system, gate design, cooling layout, shrink allowance, CMF, NRE, and lead-time data that toolmaker YYT returned.

## Toolmaker

- **Name:** Shenzhen Yuyao Tooling Co. (YYT), Bao'an District, Shenzhen, PRC
- **Class:** ISO 9001:2015; SPI Class 101 mold builder
- **References:** contract enclosure tools for Realme, Nothing, TCL (2022-2024)
- **Selected via:** competitive RFQ vs 3 other Shenzhen/Dongguan shops

## Tool Configuration

- 1+1 family tool: `orange_back_shell` + `orange_side_frame` in single SPI Class 102 mold base
- FUTABA/HASCO 350 x 450 mm A/B base, 4-pillar guide
- Target press: 120 t Haitian MA1200 II / Chen Hsong EM120-SVP/2 servo toggle
- Expected tool life: 750 000 cycles
- Annual design volume: 250 000 units

## Steel Selection

| Component | Steel | Hardness | Surface Finish | Rationale |
|---|---|---|---|---|
| Back-shell cavity (A-side) | 1.2738 P20+Ni pre-hard | 30-33 HRC | SPI-B1 + VDI 3400 ref 30 (MT-11010 light orange-peel) | Pre-hard toughness; avoids hardening distortion on cover-glass ledge |
| Back-shell core (B-side) | 1.2738 P20+Ni | 30-33 HRC | SPI-D2 dry-blast | Matches cavity expansion; holds boss core pins, ejectors |
| Side-frame cavity | 1.2738 P20+Ni | 30-33 HRC | SPI-B1 + VDI 30 | Same grade as back shell |
| Side-frame core | 1.2738 P20+Ni | 30-33 HRC | SPI-D2 | — |
| Cover-glass bonding ledge insert | Uddeholm Stavax ESR (S136 equiv) | 50-52 HRC | SPI-A2 mirror, Ra <= 0.05 um | Hardened mirror for OCA bond contact; wear-resistant |
| Camera window shutoff insert | Stavax ESR | 50-52 HRC | SPI-A2 mirror | Cosmetic glass land; prevents flash visibility |
| USB-C aperture shutoff insert | Stavax ESR | 50-52 HRC | SPI-B1 lapped | Insertion-load tolerant |
| Screw boss core pins (x6) | DIN 1.2344 H13 nitrided | 60 HRC tip | ground | Wear/galling resistance; refs `orange_screw_boss_1..6.step` |
| Snap-hook lifters (x8) | 1.2738 + Stavax wear plate + brass cage | — | ground | Galling resistance on parting plane |
| Ejector pins (x8) | DIN 1.2210 (115CrV3) nitrided | — | DME stock | Refs `mold_ejector_pin_1..8.step` |
| Submarine gates (x2) | Stavax ESR | 50-52 HRC | mirror | Withstands 42 500 1/s shear over tool life; refs `mold_left/right_submarine_gate.step` |
| Sprue bushing | DME standard hardened | — | polished | Refs `mold_sprue_bushing.stl` |

Sources: Uddeholm Stavax ESR (https://www.uddeholm.com/products/uddeholm-stavax-esr/); ThyssenKrupp 1.2738 P20+Ni datasheet (DME); SPI mold classifications (https://www.americanmoldbuilders.com/spi-mold-classifications/); Mold-Tech VDI 3400 chart (https://www.mold-tech.com/standards-charts/).

## Draft Angles

| Feature | Draft (deg) |
|---|---|
| Outer walls | 2.0 |
| Snap-hook lifter face | 1.0 |
| Boss cores | 0.5 |
| Ribs | 1.5 |
| Textured surfaces | 3.0 |

## Parting Line / Shutoffs

- Primary mid-plane around back-shell perimeter (matches `mold_parting_line_reference.stl`)
- Shutoffs: USB-C bottom-edge insert; camera-window steel-safe insert with vents 3/4; side-button openings via lifters; snap-hook openings via lifters
- Kiss-off tolerance: 0.025 mm
- Flash limit: 0.05 mm

## Ejector Layout

| Param | Value |
|---|---|
| Pin count | 8 |
| Pin diameter | 2.0 mm |
| Pin steel | DIN 1.2210 nitrided |
| Stripper plate | no (lifters handle snap-hook release) |
| Lifter count | 8 |
| Lifter stroke | 3.5 mm |
| Predicted ejection force | 380 N (limit 1200 N) |
| Witness marks on A-surface | 0 |

Pin locations (all B-side): under screw bosses 1, 2, 3, 5; under battery ribs L/R; under snap-hook 3 and 6 roots. Matches `mold_ejector_pin_1..8.stl`.

## Runner / Gate System — Cold Runner

Hot-runner was evaluated and rejected:

| Factor | Cold runner | Hot runner |
|---|---|---|
| NRE (hot-half hardware, Mold-Masters / Yudo) | 0 | $18-24k per cavity |
| 250k units/year amortization | works | does not amortize |
| PC+ABS color stability at 260 C residence | OK (purged with virgin at color change) | risk of orange masterbatch drift / brown streak at startup |
| Gate trim | auto-trim at ejection (submarine) | manual de-gating required |
| Cosmetic A-surface lot virgin policy | compatible | runner is fixed, no virgin segregation |

Runner geometry:
- Sprue 4.0 mm dia (refs `mold_sprue_bushing.stl`)
- Primary runner 2.2 mm dia (refs `mold_primary_runner.stl`)
- Secondary runner 1.6 mm dia
- Total length 82 mm, volume 3.7 cm3, mass 4.2 g
- H-pattern natural balance to two submarine gates

Gate geometry:
- Left submarine gate: 0.85 mm dia, 30 deg, 0.6 mm land, at 25% back-shell long edge B-side (`mold_left_submarine_gate.step`)
- Right submarine gate: 0.85 mm dia, 30 deg, 0.6 mm land, at 75% back-shell long edge B-side (`mold_right_submarine_gate.step`)
- Vestige on B-side only; not visible on A-surface
- Fan-gate alternate drawn-only; swap if first-shot blush exceeds CMF limit

## Cooling Layout

| Param | Value |
|---|---|
| Circuits | 3 parallel |
| Channel dia | 4.0 mm |
| Clearance | 2.0 dia to cavity |
| Coolant | water + ethylene glycol |
| Coolant temp | 82 C |
| Flow per circuit | 8 L/min |
| Reynolds number | 11 200 (turbulent) |

Channel coverage (matches `mold_cooling_channel_1..3.stl`):
- C1: back-shell screw boss field + battery rib zone
- C2: back-shell camera island + top corners
- C3: side-frame long rail + USB saddle zone

Baffles: screw bosses 1/3/5; camera-island bubbler.

Conformal cooling **not required** (cycle 26.4 s under 30 s target).

## Shrink / Warp Allowance

- Design shrinkage: 0.55% in-plane, 0.62% through-thickness
- Steel-safe offsets:
  - Cover-glass ledge: +0.05 mm
  - USB-C aperture: +0.05 mm
  - Camera window: +0.05 mm
  - Side-button openings: +0.05 mm
  - Bosses: +0.03 mm
  - Outer perimeter: +0.05 mm
- Datums match `gdt-release-package.json`: A = back outer bottom face; B = USB-C aperture CL; C = cover-glass ledge top face
- CMM tuning by SGS Shenzhen on Zeiss Contura G2 700x900x600; passes 1, 3, 5

## Orange CMF

| Param | Value |
|---|---|
| Color reference | Pantone Orange 021 C |
| Color tolerance | deltaE-CMC <= 1.2 vs production plaque |
| Gloss 60 deg | 12 +/- 3 GU (matte-satin) |
| Texture | VDI 3400 ref 30 / Mold-Tech MT-11010 light orange-peel |
| Scratch test | ASTM D3363 pencil hardness >= 2H |
| Plaque status | approved per `cmf-release-acceptance.json` |

## Tooling NRE Quote (Shenzhen 2025-2026 Bao'an SPI Class 102 rates)

| Item | USD |
|---|---|
| Back-shell cavity set | 38 000 |
| Side-frame cavity set | 22 000 |
| 8 lifter assemblies | 12 000 |
| 4 Stavax inserts | 9 000 |
| Cold runner machining | 3 500 |
| Ejector plate + pins | 4 500 |
| Cooling circuits + baffles | 5 000 |
| Mold base 350 x 450 4-pillar | 8 000 |
| Texturing + polishing | 6 500 |
| Tryout + first-shot DOE | 4 500 |
| Moldflow CAE | 3 000 |
| First-article CMM (SGS) | 2 200 |
| Freight + packaging | 1 800 |
| Contingency 10% | 12 000 |
| **TOTAL NRE** | **132 000 USD** |

Cross-checked against Protomold quick-quote estimator: $142k for equivalent SPI Class 102 PC+ABS family tool (within 8%).

Quote valid 90 days from 2026-04-14.

## Lead Time

| Stage | Weeks |
|---|---|
| Design | 2 |
| Steel procurement | 2 |
| Rough machining | 3 |
| Finish machining | 2 |
| Ejector / lifter assembly | 1 |
| Texturing | 1 |
| First shots | 1 |
| Tuning | 2 |
| **T0 to T1 samples** | **14 weeks** |

## Sources

1. SPI mold classifications — https://www.americanmoldbuilders.com/spi-mold-classifications/
2. Uddeholm Stavax ESR — https://www.uddeholm.com/products/uddeholm-stavax-esr/
3. DME 1.2738 P20+Ni datasheet — https://d-m-e.com/wp-content/uploads/2020/04/DME_steel-data-sheet_1.2738.pdf
4. Mold-Tech VDI 3400 chart — https://www.mold-tech.com/standards-charts/
5. Shenzhen Bao'an 2025 tool-shop rate sheet (analog: Realme/Nothing 2024 enclosure tooling)
6. Protomold quick-quote estimator (cross-check)
