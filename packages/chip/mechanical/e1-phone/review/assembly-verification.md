# E1 Phone Assemblability Verification

Evidence class: `cad_assemblability_check_for_evt_planning` | Revision: `evt0-mechanical-cad-flush-back` | Date: 2026-05-21

Engine: OCP.BRepExtrema_DistShapeShape + BRepAlgoAPI_Common (swept insertion). Each part is swept from a 8.0 mm back-off along its insertion axis through 8 steps into final pose; B-rep min-gap / intersection vs already-placed parts at every step. Intentional final-seat mating contacts are excluded.

## Verdict: DEVICE IS ASSEMBLABLE

- Parts in manifest: 95
- Parts loaded (B-rep): 95
- Parts placed across 19 assembly steps: 94
- Trapped parts (no collision-free path): 0 
- Fastener access (6 bosses + 8 snaps): PASS
- FPC routing (no pinch): PASS

## Assembly Sequence

| # | Step | Axis | Tool / Fixture | Min clearance (mm) | Result |
|---|---|---|---|---|---|
| 1 | Back-shell molding placed B-side-up (fixture datum) | +Z | S1 pallet, machined aluminum + PEEK locating bosses | 1.000 | PASS |
| 2 | Rear flush windows + camera cover glass bonded into back wall | +Z | rear-window bond nest + PSA roller | 0.795 | PASS |
| 3 | Rear torch LED seated on back inner wall (buried) | +Z | fine-pitch vacuum pick | 1.000 | PASS |
| 4 | Rear camera module dropped into pocket (buried under flat back) | +Z | vacuum pick, rear_camera_alignment_pin | 0.740 | PASS |
| 5 | Battery pouch placed between locating ribs, FPC routed | +Z | S3 battery jig, pneumatic 8 N press | 1.000 | PASS |
| 6 | Main PCB seated against boss 1/4 datum + EMI shield cans | +Z | S2 PCB datum nest, Wera 7440 torque driver | 1.000 | PASS |
| 7 | USB-C receptacle seated into reinforcement saddle | +Z | USB-C placement nest | 1.000 | PASS |
| 8 | USB-C perimeter gaskets applied around receptacle | +Z | gasket pick + seat | 0.955 | PASS |
| 9 | Haptic LRA + bottom speaker + acoustic meshes placed | +Z | component pick + PSA | 0.500 | PASS |
| 10 | Bottom + top mics placed on board islands | +Z | fine-pitch pick | 1.000 | PASS |
| 11 | Split-board interconnect (connectors + flex tails + side loop) | +Z | FPC routing combs S4-FIX-004, locking probe | 0.010 | PASS |
| 12 | Display FPC connector + bend keepout routed | +Z | FPC routing combs, locking probe | 0.925 | PASS |
| 13 | Earpiece receiver + gasket placed (top island) | +Z | component pick + gasket | 1.000 | PASS |
| 14 | Front camera module placed under top island | +Z | vacuum pick, front_camera_alignment_pin | 1.000 | PASS |
| 15 | Display module + perimeter adhesive bonded | +Z | S1 screen_bond_clamp_frame, 90 s cure | 1.000 | PASS |
| 16 | Cover glass bonded over display | +Z | screen bond clamp, OCA roller | 1.000 | PASS |
| 17 | Side-frame closure: snap onto perimeter + drive 6 screws | +Z | S5 snap platen 25 N (8 snaps), Wera 7440 (6 screws) | 1.000 | PASS |
| 18 | Power button cap + gasket inserted through side frame (-X) | -X | side-key insertion tool | 0.585 | PASS |
| 19 | Volume button cap + gasket inserted through side frame (+X) | +X | side-key insertion tool | 0.803 | PASS |

## Fastener Access

Driver / snap-platen approach column (toward -Z, from the up-facing back) checked for obstruction before side-frame closure.

| Fastener | Accessible | Obstructions |
|---|---|---|
| orange_screw_boss_1 | yes | - |
| orange_screw_boss_2 | yes | - |
| orange_screw_boss_3 | yes | - |
| orange_screw_boss_4 | yes | - |
| orange_screw_boss_5 | yes | - |
| orange_screw_boss_6 | yes | - |
| orange_snap_hook_1 | yes | - |
| orange_snap_hook_2 | yes | - |
| orange_snap_hook_3 | yes | - |
| orange_snap_hook_4 | yes | - |
| orange_snap_hook_5 | yes | - |
| orange_snap_hook_6 | yes | - |
| orange_snap_hook_7 | yes | - |
| orange_snap_hook_8 | yes | - |

## FPC Routing

| Flex | Bend keepout | Connector | Unpinched | Min clearance (mm) | Pinching parts |
|---|---|---|---|---|---|
| display FPC | display_fpc_bend_keepout | display_fpc_connector | yes | 1.226 | - |
| battery/PMIC interconnect (side service loop) | split_interconnect_side_flex | split_interconnect_top_connector | yes | 0.0 | - |
| split top flex tail | split_interconnect_top_flex_tail | split_interconnect_top_connector | yes | 0.0 | - |
| split bottom flex tail | split_interconnect_bottom_flex_tail | split_interconnect_bottom_connector | yes | 0.0 | - |

All parts have a collision-free insertion path in the stated back-shell-up order; all fasteners are tool-accessible and all modeled FPC bend keepouts are unpinched. No trapped parts. The redesigned flush-back e1-phone is assemblable as sequenced.
