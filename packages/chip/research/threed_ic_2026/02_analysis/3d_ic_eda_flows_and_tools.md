# State of the Art in 3D-IC EDA Flows and Tooling (2023-2026)

Scope: 3D integration styles, 3D physical-design flows and tools, thermal
co-analysis, inter-tier interconnect electrical/yield rules, and design-for-test.
Numbers are cited to primary or credible sources; vendor-marketing claims are
flagged. Prepared for the E1X3D wafer-scale RISC-V mesh program.

## Executive summary

- **Hybrid bonding is the only 3D style shipping high-volume logic-on-logic /
  cache-on-logic today.** TSMC SoIC in production since 2022; production bond
  pitch ~6 um in 2025, vendor plan ~4.5 um and ~3 um by 2027-2029. Intel Foveros
  Direct targets sub-5 um on 18A-PT in H2 2026. Treat "6-micron resurrects
  Moore's Law" syndicated articles as PR, not data.
- **Monolithic 3D (M3D) has the densest vertical interconnect but is
  research-grade for logic.** MIVs ~70 nm diameter, <1 fF parasitic C, up to
  ~30M vias/mm2 - orders of magnitude denser than TSV - but sequential
  integration is limited to ~2-4 active tiers by top-tier thermal budget
  (~500 C for HP logic, <400 C for 2D-material tiers).
- **TSV-based 3D is mature but coarse:** TSV pitch um-scale (arrays ~25 um pitch;
  HBM microbumps ~40 um now, ~10 um in HBM4), with area-consuming keep-out zones.
  Wrong granularity for splitting a small RISC-V PE.
- **Cerebras wafer-scale (WSE-3, TSMC 5nm, 900k cores, 44 GB SRAM) is 2D, not
  Z-stacked.** It crosses <1 mm scribe lines with >1M wires in high metal, with
  redundancy built into the link protocol. Canonical proof that on-wafer
  same-die-bandwidth meshing works - directly relevant to E1X3D's X/Y mesh,
  separate from the Z stacking question.
- **Open-source 3D physical design exists only as academic "pseudo-3D" flows.**
  The Georgia Tech (Sung Kyu Lim) lineage - Shrunk-2D -> Compact-2D -> Cascade2D
  -> Pin-3D -> Snap-3D - all wrap commercial 2D P&R (Innovus) rather than doing
  true-3D placement. Gains: pseudo-3D ~26% wirelength / ~10% power; Pin-3D up to
  9% shorter WL and 88% lower TNS vs die-by-die M3D; Hier-3D claims 1.2-2.2x
  PPAC vs commercial 2D (all at 28 nm academic PDKs).
- **OpenROAD has no native true-3D flow.** Recent work layers Pin-3D-style
  pseudo-3D for F2F hybrid-bonded designs on OpenROAD-Research / ORFS-Research
  forks - runnable but not mainline, not signoff-grade.
- **Commercial 3D EDA is consolidated around two stacks behind the 3Dblox 2.0
  interchange standard:** Cadence Integrity 3D-IC (+ Celsius thermal, Sigrity /
  Clarity SI/PI) and Synopsys 3DIC Compiler (+ 3DSO.ai, RedHawk-SC
  Electrothermal, Ansys HFSS-IC). Both NDA/commercial-only.
- **Thermal is the #1 risk for tall-Z logic.** Stacked HP logic produces hotspot
  fluxes up to ~250 W/cm2; the buried tier sits behind the heat-removal path.
  Microfluidic inter-tier cooling is the strongest demonstrated mitigation
  (~13% lower temp rise or ~55% lower pressure drop vs straight channels) but is
  lab-stage.
- **Logic-on-logic is thermally far harder than logic-on-memory.** AMD 3D
  V-Cache (SRAM-on-logic via SoIC) ships because SRAM is low-power; AMD reduced
  V/f on the cache-stacked die. Samsung SAINT splits this explicitly: SAINT-S
  (SRAM-on-logic), SAINT-D (DRAM-on-logic), SAINT-L (logic-on-logic), with
  SAINT-L targeted only for ~2026.
- **Yield stacking is multiplicative; W2W cannot sort.** Wafer-to-wafer bonding
  (densest, ~400 nm pitch at imec) cannot select known-good die, so stack yield
  = product of tier yields. Die-to-wafer (D2W) with KGD breaks the
  multiplication and gets productized first.
- **DfT for 3D is standardized: IEEE Std 1838-2019.** Die Wrapper Register
  (DWR) + Serial Control Mechanism (SCM) + optional Flexible Parallel Port (FPP)
  enabling pre-bond / mid-bond / post-bond / final test. Inter-layer-via BIST
  for M3D is active research.

## 1. 3D integration styles and where each is used

**Monolithic 3D (M3D / sequential / 3DSI).** Device tiers built sequentially on
one substrate; inter-tier vias (MIVs) patterned like ordinary back-end vias.
MIV geometry ~70 nm diameter, <1 fF parasitic C, density up to ~30M MIVs/mm2 -
far beyond TSV. 3DSI contact pitch <100 nm, enabling fine-grain (even
transistor-level / CFET-style) partitioning. Binding constraint: top-tier
thermal budget (~500 C for HP digital stacked-FET logic, <400 C for 2D-material
tiers), limiting practical integration to 2-4 active layers. Maturity: research /
early foundry-pathfinding, not volume logic.

**TSV-based 3D (parallel / stack-and-bond).** Separately fabricated wafers/dies
thinned and joined with through-silicon vias + microbumps. um-class scale: TSV
arrays ~25 um pitch, die thickness 30-50 um, HBM microbumps ~40 um (HBM3) ->
~10 um (HBM4). Meaningful parasitic C and stress keep-out zones. Mature/volume
(HBM, image sensors) but far too coarse to bisect a small RISC-V PE.

**Hybrid bonding / face-to-face (F2F).** Direct Cu-Cu + oxide/SiCN dielectric
bonding, no bumps - the production sweet spot for logic stacking. TSMC SoIC-X:
production since 2022, ~6 um pitch in 2025, vendor plan to ~4.5 um and ~3 um by
2027-2029; powers AMD 3D V-Cache. Intel Foveros Direct: sub-5 um on 18A-PT, H2
2026. Samsung SAINT: SAINT-S / SAINT-D / SAINT-L productized splits, 3D-stacked
SoC mass production ~2026. imec research: W2W hybrid bonding at 400 nm pitch
(IEDM 2023), path to 200 nm; D2W at 2 um pad pitch. Sub-um is research.

**Wafer-scale (Cerebras WSE-2/WSE-3).** WSE-3: single TSMC 5nm wafer, ~900,000
cores, 44 GB on-wafer SRAM, ~21 PB/s SRAM bandwidth, from ~84 reticle dies not
sawed apart. Extra lithography shorts wires across <1 mm scribe lines in
high-level metal -> cross-die links at same bandwidth as intra-die. >1M wires
cross die boundaries with redundancy in the link protocol plus on-wafer core
redundancy. MemoryX / SwarmX are off-wafer. Crucially WSE is planar X/Y
wafer-scale integration, NOT Z-stacking - it validates E1X3D's mesh/scribe layer
but says nothing about the tall-Z tier stack.

## 2. 3D physical-design flows and tools

**Open-source / academic (pseudo-3D - all wrap a 2D placer).** GT / Sung Kyu Lim
lineage folds 3D placement into a 2D problem so commercial tools can be reused:
Shrunk-2D (scale cell dims/RC ~0.5x, then split by area), Compact-2D
(better tier projection/legalization), Cascade2D (design-aware partitioning for
M3D), Pin-3D (physical synthesis + post-layout opt for heterogeneous M3D, full-3D
cell context; up to 9% smaller WL and 88% smaller TNS vs die-by-die M3D, 28 nm),
Snap-3D (constrained-placement-driven, wraps Innovus; ~10-15% WL, ~8-12% power,
~5-8% freq vs 2D at 28 nm), Hier-3D (F2F, ISLPED'22 best paper; 1.2-2.2x PPAC vs
2D). None do true-3D analytic placement - they are 2D-tool wrappers.

**OpenROAD / ORFS.** No native true-3D in mainline. Pin-3D-style F2F flows exist
on OpenROAD-Research / ORFS-Research forks - runnable for research, not
signoff-grade.

**Commercial (NDA, behind 3Dblox 2.0).** Cadence Integrity 3D-IC (+ Celsius
Thermal Solver, Sigrity SI/PI, Clarity 3D field solver). Synopsys 3DIC Compiler
+ 3DSO.ai (autonomous AI thermal/SI/PI optimizer) + RedHawk-SC Electrothermal +
Ansys HFSS-IC. Siemens Calibre 3D stacking + 3D-LVS/DRC (the cross-die
verification the academic flows lack).

## 3. Thermal co-analysis for stacked logic (the #1 tall-Z risk)

Tools: HotSpot (compact RC thermal, early VLSI); 3D-ICE (fast compact transient
thermal for 3D stacks incl. inter-tier microchannel liquid cooling; canonical
open academic tool); Ansys Icepak / RedHawk-SC Electrothermal; Cadence Celsius.

Physics: stacked HP logic hotspot fluxes up to ~250 W/cm2; buried tiers sit
behind the heat-extraction path so junction temp rides on every tier above;
vertical thermal coupling superposes hotspots. Logic-on-logic is the hard case;
logic-on-memory is tractable (3D V-Cache ships; AMD down-biases V/f on the
stacked-cache die; Samsung sequences SAINT-S/D before SAINT-L). Mitigations:
thermal/dummy TSVs, back-side cooling / BSPDN, inter-tier microfluidic cooling
(2024 topology-optimized: ~13% lower temp rise or ~55% lower pressure drop; lab
stage).

## 4. Inter-tier interconnect - electrical / yield rules

| Interconnect | Pitch (today) | Diameter | Parasitics | Density |
|---|---|---|---|---|
| MIV (monolithic) | <100 nm contact pitch | ~70 nm | <1 fF | up to ~30M/mm2 |
| Hybrid bond (Cu-Cu) | ~6 um prod (SoIC 2025); 400 nm research (W2W) | pad-defined | low R, low C | ~1e4-1e6/mm2 |
| TSV | ~25-40 um | um-scale | high C, keep-out | ~1e2-1e3/mm2 |

MIV is the only option offering intra-chip-like via budget (fine enough to split
a single PE's datapath across tiers). Hybrid bond is coarse but production-real.
TSV is coarsest. **Yield-stacking is multiplicative** (N tiers each Yi -> stack
yield ~ product(Yi) x bond yield). W2W cannot wafer-sort, so defective tiers get
bonded to good ones - the dominant reason W2W stays limited despite its pitch
advantage. D2W with KGD breaks the multiplication and productizes first.
(Caveat: test pads create topography conflicting with direct-bond flatness - a
real KGD-vs-hybrid-bond tension.) M3D sidesteps tier-bond yield but inherits
sequential-process yield risk on the top tier.

## 5. Design-for-test in 3D

IEEE Std 1838-2019: die-centric architecture - DWR (Die Wrapper Register)
per-die boundary scan for intra-die and inter-die-interconnect test; SCM
(Serial Control Mechanism) single-bit instruction transport through the stack;
FPP (optional Flexible Parallel Port) scalable multi-bit TAM. Enables pre-bond /
mid-bond / post-bond / final test. Primary target TSV stacks but not precluding
hybrid bond. Stacked memories: per-tier MBIST + inter-die interconnect test via
DWR. Inter-layer-via BIST for M3D is active research (billions of fine MIVs
cannot be probed individually). Composes with 1149.1/1687.

## Open-source/runnable vs NDA/commercial-only

| Capability | Open / runnable | NDA / commercial-only |
|---|---|---|
| 2D RTL->GDS P&R | OpenROAD / ORFS | Innovus, Fusion Compiler |
| Pseudo-3D flow | Pin-3D / Snap-3D on OpenROAD-Research/ORFS-Research (research) | Integrity 3D-IC, 3DIC Compiler (signoff) |
| True-3D analytic placement | Research prototypes only (ePlace-3D, ART-3D) | - |
| 3D thermal modeling | 3D-ICE, HotSpot | Celsius, RedHawk-SC Electrothermal, Icepak |
| 3D SI/PI / field solve | limited open | Sigrity/Clarity, HFSS-IC |
| 3D DRC/LVS (cross-die) | none signoff-grade | Calibre 3D-LVS/DRC |
| 3D DfT IP | IEEE 1838 spec public; IP vendor | Tessent |
| Interchange standard | 3Dblox 2.0 (open spec) | tool implementations |

**Bottom line:** you can prototype an E1X3D tier-split with ORFS-Research +
3D-ICE end-to-end at no license cost, but 3D DRC/LVS, electrothermal signoff,
and SI/PI all require commercial tools - there is no open signoff path for a
real 3D tapeout.

## Directly relevant to E1X3D - design implications

1. **Two orthogonal problems - solve separately.** X/Y wafer-scale mesh is the
   Cerebras-proven part (scribe crossing, link redundancy, core redundancy). The
   Z tier-stack is the unproven, thermally-limited part.
2. **Bonding: monolithic 3D (MIV) if a sequential-integration PDK is accessible;
   otherwise face-to-face hybrid bonding.** Only MIV gives a fine-enough via
   budget to split a single small PE across tiers. Production hybrid bond at ~6 um
   only stacks whole blocks (cache tier on logic tier). If E1X3D needs per-PE
   tier-splitting, M3D is architecturally required and is the binding feasibility
   risk.
3. **Tier-split: logic-on-memory, not logic-on-logic.** One logic tier + cool
   SRAM/regfile/buffer tiers. Two co-aligned high-power logic planes is the worst
   thermal case (nobody ships it yet).
4. **Thermal ceiling is the hard constraint - set it first.** Plan thermal/dummy
   TSVs and back-side cooling from day one; assume stacked tiers run at reduced
   V/f. Keep stacked logic power density low and tier count to 2-3 active tiers
   unless microfluidics is in scope.
5. **Via budget** matches bonding tech: MIV ~unlimited (~30M/mm2), hybrid bond
   ~1e4/mm2-class (whole-block interfaces, not core-slicing).
6. **Yield: D2W + KGD, never W2W, for the Z stack.** Extend redundancy thinking
   to Z; bond only KGD tiers.
7. **DfT from the start (IEEE 1838).** Wrap each tier with a DWR; budget MIV BIST
   for M3D.
8. **Tooling plan:** prototype with ORFS-Research (Pin-3D/Snap-3D) + 3D-ICE;
   expect ~10-26% WL and ~10% power upside vs 2D at partition level; budget for
   commercial signoff for any real tapeout (fail-closed).

## Sources

See parent index. Key URLs: Tom's Hardware TSMC SoIC plan; TSMC 3DFabric SoIC;
Intel Foveros Direct 18A-PT; Samsung SAINT (TrendForce / Tom's Hardware / Sammy
Fans); imec W2W 400 nm / D2W 2 um; arXiv 2306.14033 (MIV transistor M3D); Nature
Electronics s41928-024-01251-8; BU PEAC TCAS-II Mono3D tutorial; Cerebras
architecture deep dive + arXiv 2503.11698; Pin-3D (IEEE 9256807); pseudo-3D ACM
TODAES 10.1145/3453480; Snap-3D (GT-CAD tcad23-pruek); Hier-3D (GT ECE);
OpenROAD; Cadence Integrity 3D-IC; Synopsys 3DIC Compiler + 3DSO.ai; 3Dblox 2.0
(EE News); 3D-ICE (IEEE 5653749); interlayer cooling (ScienceDirect
S1359431124009220); IEEE Std 1838-2019 (9036129); GT MIV BIST (08791515);
CEA-Leti KGD (cea-03759970); Yole AMD 3D V-Cache SoIC.

Skeptic flags: "N-micron resurrects Moore's Law" syndicated PR not used for
quantitative claims; foundry pitch plans are vendor-stated; academic PPA % are
28 nm research PDKs and may not transfer; microfluidic cooling numbers are lab
demonstrations.
