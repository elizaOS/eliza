# Unitree R1 Bodykit Sourcing and Cost Plan

Date: 2026-05-23

## Source Model

- Base robot: Unitree R1.
- Official R1 page lists R1 Air at $4,900, R1 at $5,900, R1 EDU as contact-sales, standing dimensions 1230 x 357 x 190 mm, and about 27-29 kg with battery: https://www.unitree.com/mobile/R1/
- Unitree shop currently lists R1 pre-sale from $4,900, shipments beginning in June 2026, shipping costs between $300 and $1,200, and a note that non-EDU R1 does not support secondary development: https://shop.unitree.com/products/unitree-r1
- Unitree R1 developer documentation landing page used for reference imagery and current platform documentation: https://support.unitree.com/home/en/R1_developer
- H1 component overview reference used only as a shell-layout precedent for humanoid covers and joint clearance, not as R1 geometry: https://www.docs.quadruped.de/projects/h1/html/_images/h1_component_overview.png
- Simulation source used here: `unitreerobotics/unitree_mujoco`, folder `unitree_robots/r1`, vendored at commit `c598f103acb87a5fd3de7c9037f4dab6aa7f232b`.

## Fabrication Sources

- FDM prototype: local ASA/PETG printer or service bureau. Use `out/meshes/*.stl` for first fit checks.
- PA12/SLS/MJF prototype: Shapeways PA12 or equivalent. Shapeways PA12 publishes max bounding boxes up to 650 x 350 x 550 mm for standard white, and wall guidance of 0.7 mm standard / 1.5 mm smooth; this project keeps a stronger 2.4 mm print-wall target. Source: https://www.shapeways.com/materials/pa12
- Injection molding: Xometry, Protolabs, Fictiv, Hubs, TEAM MFG, JLC/PCBWay-style China tooling vendors. Xometry notes injection molding can range from $10,000 or less to $100,000 depending on order size and part complexity, and lists resin costs such as ABS around $1.30/lb and PC around $2.30/lb. Source: https://www.xometry.com/resources/injection-molding/injection-molding-cost/
- Xometry injection molding service page lists aluminum tooling for bridge/prototype work, steel tooling for production, Class 105 through Class 101 mold grades, and common rigid plastics including ABS, ASA, PC, PA, PBT, and PC-ABS quote paths: https://www.xometry.com/injection-molding/
- Protolabs injection molding design/cost guidance used for mold-cost drivers, part-size constraints, and DFM planning: https://www.protolabs.com/resources/design-tips/11-tips-to-reduce-injection-molding-costs/
- Hubs injection molding guide used for family-mold, cost-driver, and DFM references: https://www.hubs.com/guides/injection-molding/
- Fictiv injection molding service used as a bridge-production and aluminum/steel mold sourcing path: https://www.fictiv.com/injection-molding-service

## Face / Head Suppliers

- NeuroFace: standalone hyper-realistic robotic head product, 12-15 DOF facial system, modular integration claim. Source: https://neuroface.tech/en/
- Engineered Arts Mesmer/Ameca family: high-end expressive humanoid head/face systems, custom skin/character path. Source: https://engineeredarts.com/robots/mesmer
- Hanson Robotics: custom/research humanoid face and head systems. Source: https://www.hansonrobotics.com/
- FACEHEAD.CO: custom animatronics and hyper-realistic moving sculpture/facial work. Source: https://www.facehead.co/
- Silicone Mask Laboratory: custom silicone masks and humanoid robot skins. Source: https://siliconemasklab.com/

For this project revision, the checked-in model uses a hard-plastic stylized face shell and does not include hair or glasses.

## Current Bodykit Evidence

The structured cost model is checked in at `mechanical/unitree-r1-bodykit/review/sourcing-cost-model.json`.

- Current bodykit part count: 69 cosmetic hard-plastic parts.
- STEP export status: 69 exported, 0 blocked by mesh-derived or non-tooling geometry.
- Simulator verdict: pass.
- Panel-gap verdict: pass.
- Production-clearance verdict: needs-work.
- Part-review verdict: needs-work.
- Prototype volume proxy: 34,731.34 cm3 from the current solid EVT meshes. This is not the final shell volume; production CAD must be hollowed and rebuilt with walls, ribs, bosses, split lines, draft, and real mounting features before RFQ.

## Unit Cost Model

Assumptions:

- 37 cosmetic hard-plastic parts in the current EVT mesh set.
- Prototype mass estimate is not final because the current 34,731.34 cm3 volume is a solid proxy. Actual printed/molded mass depends on wall thickness, hollowing, ribs, bosses, infill, and support strategy.
- Injection-mold production version will need part splits, bosses, ribs, draft, texture, and STEP solids before quoting.
- Tooling estimate assumes family tools where DFM allows; final tool count depends on part splits, color/material breaks, surface class, and undercut removal.

| Quantity | Process | Estimated unit cost for bodykit only | Upfront tooling/NRE | Notes |
|---:|---|---:|---:|---|
| 1 | FDM ASA/PETG prototype + filler/sanding/paint + hand-fit hardware | $1,800-$5,200 | $0-$6,000 | Best for first chassis fit and aesthetic review. Not production-grade without substantial finishing labor. |
| 100 | SLS/MJF PA12 pilot run or bridge tooling for selected repeat parts | $750-$2,200 | $12,000-$85,000 | Use only after production clearance passes. Paint and hand assembly still dominate. |
| 1,000 | Aluminum or mixed aluminum/steel injection tooling | $190-$620 | $180,000-$520,000 | Likely crossover range for molded shells if common materials/colors can be family-tooled. |
| 10,000 | Production steel tooling, multi-cavity or family tools | $70-$240 | $380,000-$1,200,000 | Requires frozen production CAD, QA fixtures, packaging, and color/texture control. |

R1 base robot cost is not included above. Add the Unitree R1 cost separately: currently from $4,900 officially for R1 Air, $5,900 for R1, or contact-sales for EDU.

## RFQ Package Required Before Quotes

- Production STEP for all 37 parts.
- Per-part material and finish callouts.
- 2D critical dimensions and tolerance drawings for mounting features.
- Molded wall section analysis.
- Parting-line and draft review.
- Clearance report passing static and dynamic gates.
- Assembly BOM with fasteners, inserts, magnets, adhesive, and paint masks.
- Rendered appearance target and color/texture chips.

## Open Blockers

- Production clearance is still `needs-work`.
- No current bodykit parts are blocked from STEP export.
- Part review is still `needs-work`.
- Current face shell is a donor-derived parametric grid loft; it still needs surface-class review and final production DFM.
- Current cost numbers are planning ranges and require supplier RFQ.

## Procurement Checklist

- Ask Unitree for final R1 CAD/STEP or controlled mechanical envelopes for the exact purchased variant.
- Quote one FDM prototype set from local ASA/PETG and one PA12/MJF set.
- Quote hard-plastic face shell separately from animatronic face suppliers if the project moves beyond the generated stylized shell.
- Choose production material: PC-ABS for glossy armor; black PC-ABS/ABS for underbody; painted hard face shell.
- Convert mesh primitives to STEP solids with CadQuery/OCP or FreeCAD before injection-mold RFQ.
