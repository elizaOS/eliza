# E1X3D Design Decisions (checked contract)

Distilled from `02_analysis/`. These are the committed parameters and the
fail-closed gates that bound each unproven claim. The architecture model
implements this contract in `compiler/runtime/e1x3d_wafer_model.py`; the design
narrative is `docs/arch/e1x3d-wafer-stack.md`.

## What E1X3D is

A 3D extension of E1X: the same Cerebras-style planar wafer mesh of tiny RV64
processing elements, now **stacked in Z**. Each logical core sits in a vertical
**column** spanning `logical_tiers` *logic* tiers; each logic tier carries
`memory_tiers_per_core` folded SRAM tiers above it (memory-on-logic). The fabric
is a 3D mesh (X/Y in-plane + Z between adjacent logic tiers) and repairs around
dead cores, dead in-plane links, dead inter-tier (Z) links, and **dead whole
tiers** (graceful column degradation).

## Committed decisions (with the research that forces them)

| Decision | Value | Why (source) |
|---|---|---|
| Z fabric depth (active logic tiers) | `logical_tiers = 2`, hard max 4 | 2-tier folding = the characterized sweet spot; >4 logic tiers collapse on thermal + yield. |
| Tier split style | memory-on-logic (logic tier + folded SRAM tier) | logic-on-logic is the worst thermal case; nobody ships it. SRAM tier = thermal buffer + the 3D V-Cache pattern. |
| XY footprint shrink from folding | ~36% per core (block SRAM-on-logic; up to ~64% with 2 SRAM tiers), NOT 2x/tier | Derived in e1x3d_placement_model (logic 0.018 over SRAM 0.032 -> 0.36). Open3DBench two-tier: -51% area, but full-chip folding is ~ -36-50%, not naive 2x. |
| Per-core SRAM | 48 KiB x (1 + memory_tiers_per_core) | stack SRAM tiers to grow local memory without growing XY (wordline-folded 3D SRAM ~ -57% footprint). |
| Bonding | `hybrid_bond_f2f` default; `monolithic_miv` for per-PE split | F2F (~6 um) = production, block-level. MIV (~70 nm) = only way to split a *small* PE, research TRL. |
| Inter-tier via budget | F2F ~1e4/mm2; MIV ~30M/mm2 | sets how fine the tier split can be. |
| Defect repair | dead core/link/Z-link/tier; spare rows/cols/planes | Cerebras fine-grained sparing + dead-tier-aware Z routing (the research gap). |
| Spare budget | ~1.5% spare cores per tier + spare planes | Cerebras-class; sized by expected faults + margin under Y=exp(-D*A). |
| Routing | 3D mesh, 6-neighbor + Local + Drop | odd-even / LBDRe2-style deadlock-free base + Z fault domain. |
| Direction encoding | reuse E1X 3-bit dir: N=0,E=1,S=2,W=3,Local=4,UP=5,DOWN=6,Drop=7 | the repair ROM route word already carries a 3-bit dir field - no format break. |
| Thermal ceiling | <= 1.0 W/mm2 per active logic tier; +10% peak temp budget for 2 tiers | NSF 100-150 W/cm2 per layer; Open3DBench +10% temp for 2 tiers. |
| Cooling assumption | backside / dual-sided; stacked tiers at reduced V/f | DSC -72.2% deltaT at 100 W; AMD 3D V-Cache down-bias precedent. |
| Test | D2W + KGD/KGS; IEEE 1838 DWR/SCM | W2W cannot sort; stack yield compounds. |

## Fail-closed gates (claims we cannot prove open-source)

Per `AGENTS.md`, every blocked milestone fails closed with a stated missing
dependency. E1X3D gates:

- **`e1x3d-thermal-gate`** - PASS only if `logical_tiers <= thermal_max_logic_tiers`
  AND modeled per-tier power density <= ceiling AND a cooling assist is declared
  when needed. Otherwise BLOCKED ("stacked-logic thermal ceiling exceeded").
- **`e1x3d-yield-gate`** - PASS only if modeled stack yield (per-tier Poisson x
  bond yield) after spare-plane repair >= target; else BLOCKED.
- **`e1x3d-benchmark`** - architecture-simulator gate (mirrors `e1x-benchmark`):
  3D defect repair + thermal + yield + E1X comparison, schema-validated.
- **`e1x3d-signoff` (BLOCKED, documented)** - 3D DRC/LVS, electrothermal signoff,
  SI/PI require commercial tools (Integrity 3D-IC / 3DIC Compiler / Celsius /
  RedHawk-SC / Calibre 3D). No open path. Records the missing dependency and the
  command that would prove it.
- **`e1x3d-placement` (open prototype)** - tier-partition + folded-2D placement
  feasibility via the Open3DBench/Pin-3D pseudo-3D model; deterministic model
  runnable natively, real ORFS-Research run is the BLOCKED escalation.

## Claim boundary

E1X3D evidence is **architecture-simulation only** - not RTL signoff, not PDK,
not silicon, not a real 3D tapeout. The X/Y wafer mesh is Cerebras-proven; the Z
tier-stack, dead-tier routing, multi-tier thermal, and stacked yield are modeled
and fail closed where they depend on unavailable commercial 3D EDA, a
sequential-integration PDK, or measured silicon.
