# 3D Placement, 3D-IC Benchmarks, and Wafer-Scale Defect-Tolerance

For E1X3D: a Cerebras-style wafer-scale RISC-V mesh with cores small in X/Y and
tall in Z. Numbers quoted from cited primary sources; marketing claims flagged.

## Executive summary

- **Analytic 3D placement is real and GPU-accelerated.** ePlace-3D (ISPD'16)
  extends the electrostatics/Poisson density formulation to a 3D charge field:
  6.4% / 37.2% shorter WL and 9.1% / 10.3% fewer TSVs vs mPL6-3D and
  NTUplace3-3D on IBM-PLACE. Modern GPU die-to-die placers beat the ICCAD-2022
  contest first-place by up to 6.1% WL (4.1% avg) with 9.8x runtime speedup.
- **Two-tier folding buys ~50% footprint and ~15-25% WL, not 2x.** Open3DBench
  (open, runnable) for memory-on-logic two-tier F2F: -24.1% WL, -51.2%
  area/footprint, -5.7% power, +16.2% WNS - but +10% peak temperature. GT/Lim
  7nm M3D: ~16.8% iso-performance power reduction vs 2D.
- **More tiers help with diminishing returns** and a rising thermal penalty;
  realistic sweet spot for active logic is 2-4 tiers, not "tall Z."
- **Cerebras WSE-3 is the existence proof for wafer-scale yield:** TSMC 5nm,
  46,225 mm2, ~4T transistors, 900,000 active cores (~970,000 physical, ~93%
  utilization), 44 GB on-chip SRAM, ~0.05 mm2/core.
- **Yield is solved by fine-grained sparing, not heroics:** ~1-1.5% redundant
  cores + reconfigurable redundant fabric links; a defect disables ~0.05 mm2
  (a core) instead of ~6 mm2 (a GPU SM).
- **Defect-tolerant mesh routing is mature in 2D and exists in 3D:** odd-even
  turn model, logic-based deadlock-free routing (LOFT / LBDRe2 for 3D, no
  virtual channels), Hamiltonian/spanning-tree fallback, runtime reconfiguration
  around dead nodes/links. Z (dead-tier) handling is least mature - where E1X3D
  must invest.
- **Per-tier yield compounds multiplicatively** (Poisson Y = exp(-D*A));
  KGD/KGS test + TSV/bond redundancy mandatory above ~2 tiers. W2W can't sort
  KGD; D2W can.
- **Thermal is the hard ceiling on tall-Z logic.** Stacked HP logic targets
  ~100-150 W/cm2 (1.0-1.5 W/mm2) per layer; upper tiers run hotter for identical
  power. Dual-sided cooling cut deltaT 72.2% at 100 W in one study.
- **TSV reliability degrades with tall stacks:** CTE-mismatch stress,
  thermal-cycling fatigue/voiding, higher current density (Black's equation) all
  worsen with tier count and require keep-out zones.
- **Open, runnable assets exist:** Open3DBench, RosettaStone 2.0 / Pin-3D
  (ORFS-Research), DREAMPlace, OpenROAD, ASAP7/Nangate45_3D, ICCAD-2022/2023
  contest benchmarks. GT/Lim transistor-level folding and Cerebras internals are
  NDA/commercial.

## 1. 3D placement algorithms

**Tier partitioning.** Converts a 2D netlist into 3D by assigning each instance
to a tier; drives final PPA. Long-standing SOTA is bin-based min-cut
(area-balanced bins, min-cut between tiers) - criticized for timing degradation,
3D routing overhead, redundant MIV insertion. Alternatives: placement-driven /
min-overflow partitioning (O(N), off-loads routing demand between tiers);
TP-GNN (DAC'20) - GNN tier partitioner, on OpenPiton +27.4% perf, -7.7% WL,
-20.3% energy/cycle vs bin-based; analytical quadratic partitioning. Lesson:
partition with a placement/timing-aware objective, not pure area balance.

**Analytic 3D placement (electrostatics).** ePlace/RePlAce -> DREAMPlace family:
each cell is a charge, density cost = electrostatic potential energy, Poisson via
FFT. DREAMPlace casts placement as NN training in PyTorch (~30-40x GPU speedup
over multithreaded RePlAce, no quality loss). ePlace-3D: flat analytic mixed-size
true-3D, 3D density function, 3D spectral solution, 3D nonlinear preconditioner,
interleaved 2D-3D scheme. GPU die-to-die 3D (2023, arXiv 2310.07424): bistratal
WL model for F2F heterogeneous-node 3D, partitions and places simultaneously,
beats ICCAD-2022 1st by up to 6.1% WL, 9.8x faster. Folded-2D (Pin-3D /
RosettaStone 2.0) models hybrid-bond terminals as special vias in an extended 2D
metal stack so unmodified 2D routers handle cross-tier nets - more
tool-compatible and what most open flows run; true-3D (ePlace-3D) optimizes all
tiers jointly.

**Thermal-aware 3D placement.** Add temperature/power-density term: interleave
high-power modules across contiguous tiers; move high-power cells near-heatsink;
vertically align TSVs under high-power cells as heat pipes; aim for uniform
per-layer temp. Upper dies are intrinsic hotspots due to higher thermal
resistance to the sink even at modest power.

**Inter-tier-via planning.** Minimize/de-congest vertical connections. Pure
area-balanced min-cut over-inserts MIVs. HBT geometry (Pin-3D ref): 0.5 um width
/ 0.5 um spacing / 1.0 um pitch, 0.02 ohm per terminal, modeled as vias.
Co-objectives: via count (WL/timing), via congestion (routability), via-as-heat.

**ML / RL.** AlphaChip (Nature 2021 + 2024 addendum; open circuit_training): RL
floorplanning, macro placements comparable/superior to humans in <6 hours, taped
out in TPU-v5 - but 2D macro placement only, no published true-3D AlphaChip, and
human-parity publicly disputed. 3D-relevant RL: ART-3D (ISPD'22, GT) analytic 3D
with RL-tuned params; TP-GNN for partitioning. Strongest 3D results come from
analytic placers, not RL.

**"Small in XY, tall in Z" - per-core 3D folding (the core E1X3D idea).**
Transistor-level M3D std cells (fold pull-down on pull-up; GT "stitching" fixes
static-power-integrity) - most aggressive XY-shrink but fab-process-bound. 3D
SRAM folding: wordline-folded -57.5% footprint; bitline-folded +17.2% read /
+54.2% write latency improvement. CNT M3D 32 KB: -33% footprint, -10% latency,
-19% energy vs 2D. **Reality check on PPA:** measured full-chip two-tier folding
~ -50% footprint, -15-25% WL, -6-17% power - NOT a clean 2x density per added
tier, and ~+10% temperature. Memory-on-logic is the safest, best-characterized
split; splitting a logic datapath/regfile across tiers (logic-on-logic) is harder
for timing and thermals.

## 2. 3D-IC benchmarks & contests

Contests: ISPD 2005 / ICCAD 2015 classic 2D Bookshelf (reused as 3D inputs via
RosettaStone); ICCAD 2022 Problem B "3D Placement with D2D Vertical Connections"
(heterogeneous F2F mixed-size; partitioning + placement + eval metric); ICCAD
2023 Problem B "3D Placement with Macros"; ISPD 2025 F2F hybrid-bonding placement
papers. Metrics: HPWL/routed WL, vertical-interconnect count, WNS/TNS, area per
tier, peak temperature (Open3DBench).

Academic benchmark sets (GT/Lim): OpenPiton, RocketChip, Ariane (RISC-V),
BlackParrot, SweRV, AES/IBEX/JPEG on Nangate45 / Nangate45_3D / ASAP7 / ASAP7_3D.
2D->3D deltas: OpenPiton +27.4% perf / -7.7% WL / -20.3% energy (TP-GNN); GT 7nm
M3D ~16.8% iso-perf power; Open3DBench -24.1% WL / -51.2% area / -5.7% power /
+16.2% WNS / +10% temp.

Open, runnable assets: **Open3DBench** (open 3D backend on ORFS: Yosys,
DREAMPlace, FastRoute/TritonRoute, OpenSTA, OpenRCX, HotSpot 7.0 thermal,
Nangate45_3D, 8 designs incl. Ariane/BlackParrot/SweRV;
github.com/lamda-bbo/Open3DBench); **RosettaStone 2.0 / Pin-3D** (RTL-to-GDS 2D
and F2F-3D, CI + METRICS2.1; ieee-ceda-datc/OpenROAD-Research + ORFS-Research;
TritonPart partitioning, alternating-tier placement, 3D CTS/routing);
DREAMPlace 2/3/4; OpenROAD; ASAP7; NanGate45; ICCAD-2022/2023 benchmarks.
Recommendation: prototype E1X3D placement on Open3DBench + Pin-3D driven by
DREAMPlace (+ ePlace-3D for true-3D experiments), RISC-V cores as the unit cell.

## 3. Wafer-scale & defect-tolerant fabric (Cerebras-style)

Concrete numbers:

| | WSE-2 | WSE-3 |
|---|---|---|
| Process | TSMC 7nm | TSMC 5nm |
| Die area | ~46,225 mm2 | 46,225 mm2 |
| Transistors | 2.6 T | ~4 T |
| Cores | 850,000 | 900,000 active (~970,000 physical, ~93% util.) |
| On-chip SRAM | 40 GB | 44 GB |
| Per-core SRAM | ~48 KB | ~48 KB |
| Core area | - | ~0.05 mm2 |
| Fabric BW | - | 21 PB/s on-chip |

How yield is achieved: fine-grained sparing (~1-1.5% redundant cores) + a
dynamically reconfigurable mesh fabric with redundant links. On defect-free
regions spares are disabled; on a defect a local spare replaces the bad core and
the fabric reroutes around it. Cerebras framing: a defect disables ~0.05 mm2 vs
~6 mm2 (an H100 SM) -> "~100x more fault-tolerant" per-defect (vendor figure;
architecture corroborated, multipliers vendor-favorable).

Defect-tolerant NoC routing (2D->3D): 2D mature - reconfigurable fault-tolerant
2D-mesh, odd-even turn model, minimal-path fault-tolerant with node+link
failures. 3D - LOFT (low-overhead, no virtual channels, deadlock-free via
logic-based LBDRe2 guided by Complete-OE turn model); adaptive/passage-based
3D-mesh; Bypass-Link-on-Demand (BLoD); Hamiltonian/spanning-tree fallback;
runtime reconfiguration on router failure. **Dead-tier (Z) handling is the least
mature - most 3D schemes assume sparse faults, not a whole missing plane.**

Redundancy/repair math: yield follows Poisson Y = exp(-D*A); clustering better
modeled by negative-binomial (clustering raises yield by concentrating defects).
Spare rows/columns (and 3D analog spare planes) is the canonical model;
mixed-Poisson computes repaired yield and partially-good harvesting. ~1-1.5%
spares suffice because faults are sparse/random at modern defect densities; spare
budget set by (expected faults + margin), not worst case.

## 4. Yield, TSV/hybrid-bond defectivity, KGD, reliability for tall stacks

Per-tier yield compounds: stack yield ~ product(tier yields) x bond yield x TSV
yield. Each added active tier multiplies in another exp(-D*A), so untested tall
stacks collapse yield -> KGD matters. KGD/KGS: pre-bond Known-Good-Die +
post-bond Known-Good-Stack mandatory; D2W allows KGD sorting (productized first),
W2W cannot sort. YAP+ models W2W/D2W hybrid-bond yield incl. overlay
misalignment, particles, Cu recess, surface roughness, pad density. TSV/bond
defects: pre-bond TSV test + TSV redundancy (spare vias) standard; KGD test cost
grows with tiers. Reliability of tall stacks: CTE-mismatch stress (mobility
variation + interfacial cracking), thermal-cycling fatigue (void/crack in TSVs),
electromigration worse in small TSVs (higher current density, Black's-equation
lifetime drop), wafer warpage after anneal. All scale against tall Z and force
TSV keep-out zones.

## 5. Thermal limits of tall-Z logic stacks

Power-density ceiling: stacked HP logic research targets removing ~100-150 W/cm2
(1.0-1.5 W/mm2) per layer; multi-tier active logic pushes total W/mm3 far past
single-side heatsink conduction. deltaT per tier: upper tiers run hotter for
identical power because heat must traverse all lower tiers + interfaces to the
sink; cumulative thermal resistance makes the top tier the hotspot. Open3DBench
measured +10% peak temp for just two tiers. Why tall-Z-full-of-logic is
dangerous: 3D concentrates power while removing lateral heat-spreading area.
Mitigations (ranked): (1) memory tiers between logic tiers (SRAM lower-power,
thermal buffer); (2) backside / dual-sided cooling (DSC -72.2% deltaT at 100 W);
(3) interlayer microfluidics (CMOSAIC); (4) TSVs as vertical heat pipes under
hotspots; (5) duty cycling / dark silicon.

## Directly relevant to E1X3D - design implications

1. **Tier count: 2 tiers baseline, 4 max for active logic.** Two-tier folding
   delivers ~50% footprint / 15-25% WL / 6-17% power at +10% temp. Beyond ~4
   active-logic tiers, yield compounding and thermal resistance dominate; reserve
   higher Z only for memory/SRAM tiers. "Tall Z full of logic" is contraindicated.
2. **Make the PE small in XY via memory-on-logic + SRAM folding, not
   logic-on-logic.** Put each PE's SRAM (~48 KB) on an upper tier over its logic;
   wordline-folded 3D SRAM ~ -57% footprint. Realistic XY pitch shrink ~40-50%,
   NOT naive 2x/tier.
3. **Fabric / defect routing: 2D-mature turn-model core + explicit Z fault
   domain.** odd-even / LBDRe2-style logic-based deadlock-free routing with
   reconfiguration in-plane, plus a dead-tier-aware layer: treat each Z column as
   a fault domain with vertical bypass links so a dead tier degrades a column to
   fewer-tier operation rather than killing it. The genuine research gap.
4. **Spare budget: ~1.5% spare cores per tier + per-tier spare-plane
   harvesting.** Plus TSV/HBT redundancy (spare vias) and graceful column
   degradation.
5. **Test plan must be D2W with KGD/KGS** for any stack >2 tiers.
6. **Thermal ceiling: <=~1.0 W/mm2 per active tier; interleave memory tiers; plan
   backside/dual-sided cooling.** DSC ~72% deltaT reduction at 100 W is the
   enabling lever; else upper-tier duty cycle must drop (dark silicon). TSVs/HBTs
   as thermal vias under hotspots.
7. **Toolchain: prototype on Open3DBench + Pin-3D with DREAMPlace**, RISC-V cores
   as the repeating PE; partition with a placement/timing-aware partitioner
   (avoid pure area-balanced min-cut).

**Bottom line:** combine Cerebras's proven wafer-scale recipe (fine-grained
~1.5% spares + reconfigurable mesh) with modest, well-characterized 3D folding
(2 logic tiers + memory tiers, ~40-50% XY shrink), and treat dead-tier-aware Z
routing and multi-tier thermal/yield as the two true research risks. The data
does not support "tall Z stuffed with active logic"; it supports "short stack,
memory on top, route around everything, cool from both sides."

## Sources

See parent index. Key URLs: ePlace-3D (cseweb.ucsd.edu eplace-3d-ispd16; arXiv
1512.08291); DREAMPlace (DAC'19; 3.0 ACM 10.1145/3400302.3415691); GPU D2D 3D
(arXiv 2310.07424; ICCAD-2022 Problem B 10.1145/3508352.3561108; ICCAD-2023
10323747); Open3DBench (arXiv 2503.12946; github.com/lamda-bbo/Open3DBench);
RosettaStone 2.0/Pin-3D (arXiv 2601.17520; ieee-ceda-datc/OpenROAD-Research +
ORFS-Research); TP-GNN (GT-CAD DAC20_TP-GNN); Cerebras WSE-3 + 100x defect
tolerance blog + arXiv 2503.11698 + WikiChip; LOFT (ScienceDirect
S0167926015000991); 3D-NoC fault tolerance (arXiv 2003.09616); YAP+ (UCLA
NanoCAD c133); SRAM redundancy yield (smtnet); TSV reliability (ScienceDirect
S0026271412002181); dual-sided cooling (ScienceDirect S1879239125001638);
NSF thermal scaffolding (par.nsf 10549055); AlphaChip (Nature s41586-021-03544-w
+ 2024 addendum; circuit_training; controversy wiki); GT 3D SRAM folding
(par.nsf 10632558); 2D-FET M3D SRAM (Nature Comms s41467-025-59993-8); ASAP7;
NanGate45.

Skeptical caveats: Cerebras 100x/164x are vendor figures (architecture
corroborated); AlphaChip human-parity peer-reviewed but disputed; "18 MB/core"
secondary sources conflate aggregate vs per-core memory; all PPA deltas are
design/PDK-specific - treat as ranges.
