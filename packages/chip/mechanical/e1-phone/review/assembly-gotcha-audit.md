# E1 Phone — Exhaustive Assembly-Gotcha Audit (DFA)

evidence_class: `dfa_gotcha_audit_for_evt_planning_not_measured_hardware`
Revision: `evt0-mechanical-cad-flush-back` (swell-camera-seal + wave-2 + thickness rev) | Date: 2026-05-21
Reviewer: senior DFA engineer. Basis: `out/assembly-manifest.json` (123 solids), `review/assembly-verification.{md,json}`, `review/assembly-line-flow.md`, `review/design-change-flush-back.md`, re-run of `scripts/check_e1_phone_assemblability.py`.

## Checker re-run (current state)

```
assemblable=True steps=19 trapped=0 fastener_pass=True fpc_pass=True runtime=14.57s
```

The checker returns PASS, but its scope is narrower than the as-designed BOM. Two structural scope gaps drive the top blockers below:

- **Boss-count mismatch.** Wave-2 raised `screw_boss_count` 6 -> 10 (`orange_screw_boss_1..10` all present in the manifest), but the checker's `check_fastener_access` and the `BACK_SHELL_MOLDED` set still enumerate only `orange_screw_boss_1..6`. Bosses 7,8,9,10 are never torque-access-checked and the line-flow doc still drives only "6 M1.4 fasteners" (S2 4 + S5 2). Four real fasteners have no verified driver column and no station that installs them.
- **28 manifest solids are never placed** in any of the 19 steps: `battery_back_void_foam_pad`, `glass_perimeter_cushion_{top,bottom,left,right}`, `orange_corner_rib_{1..4}(+_leg)` (8), `antenna_aperture_tuner`, `rear_flash_camera_septum`, `orange_rear_camera_bezel_*` (4), `orange_rear_flash_bezel_*` (4), `rear_camera_shell_aperture`, `rear_flash_shell_aperture`, `orange_screw_boss_{7,8,9,10}`. Co-molded ribs/bezels/apertures are acceptable as molded-in (arrive with the shell), but the **swell-void foam pad, glass perimeter cushions, and antenna tuner are discrete installed parts with no station, no insertion check, and no operator instruction** — i.e. broken pipelines per Commandment 10.

The line-flow doc is also stale against the current CAD: header still reads `78 x 153.6 x 9.6 mm` and `185 g` (design is 11.8 mm), S3 still cites `LP446487` `4500 mAh`-class and `5.7 mm` placement vs the 5.6 mm / 5727 mAh cell, and S3 prose says battery seats *before* PCB while routing battery FPC to PMIC — but the PMIC connector lives on `main_pcb` which is not placed until S2->S6. These are documentation-vs-design drifts that will mis-instruct operators.

## Gotcha register

Severity: **blocker** = phone cannot be built / a real part has no install path; **major** = high defect/yield/safety risk needing a fixture or sequence change; **minor** = cosmetic/efficiency/handling refinement.

### 1. Insertion order & trapped parts

- **G01 / blocker** — `battery_back_void_foam_pad` (bounds z -4.75..-4.57, behind the cell) has no assembly step. The 0.6 mm swell-void compliant foam shelf must be placed on the back inner wall *before* the battery (S3) or it is trapped under a bonded cell forever. As sequenced it is omitted, so the drop-hardening DROP-2 / swell mitigation is physically absent on the line. *Mitigation:* insert a new step before current S5/Step5: bond foam pad to back inner wall on the S3 jig; add to checker `ASSEMBLY` ahead of `battery_pouch`.
- **G02 / major** — Two-sided build risk is avoided by the chosen single-side (back-up) order, but display+cover-glass bond (S15/16) happens *before* side-frame closure and screws (S17). A display reject at S6 functional test forces destroying the cover-glass bond to reach the PCB. *Mitigation:* keep test points accessible pre-close (see G24) so most rejects are caught before the irreversible bond; treat post-bond PCB rework as scrap-class.
- **G03 / minor** — `antenna_aperture_tuner` (Qorvo QPC1252Q, on PCB at z -1.85..-1.35) arrives with `main_pcb` as a reflowed component, so it is not separately trapped — but it is not called out in S2 AOI. *Mitigation:* add tuner presence/orientation to S2 AOI shield/component check.

### 2. Tool & driver access

- **G04 / blocker** — Bosses 7,8,9,10 (`orange_screw_boss_7..10`, the two mid and two extra corner-tie fasteners, x = ±27..31, y at ±18 and +36..40) are never driven or access-verified. The drop-hardening corner-stiffness claim (SF 0.78 -> 2.11) depends on 10 fastened bosses + corner gussets; building only 6 leaves the structure under-fastened. *Mitigation:* extend `check_fastener_access` to `range(1,11)`; assign all 10 to S2/S5 with a torque map; update line-flow "6 screws" -> "10 screws".
- **G05 / major** — Bosses 5/6 (x ±27, y +18, z -5.3..-2.5) sit beside the battery (battery x ±32). The M1.4 driver column is verified clear in the checker, but at S5 the battery is already bonded; a slipped driver can puncture the LiPo pouch ~5 mm away. *Mitigation:* drive bosses 5/6 (and any boss within 8 mm of the cell) at S2 *before* battery placement, or use a shrouded bit + torque-limited driver (Wera 7440 already specified) with a battery guard plate on the S5 fixture.
- **G06 / minor** — FPC ZIF/B2B seating at S4 is by "locking probe"; driver and probe share the open-back approach but at different islands. No reach conflict found (connectors at z -1.7..-0.4, well above PCB). *Mitigation:* none required; retain locking-probe AOI confirmation.

### 3. FPC handling

- **G07 / major** — Battery FPC routes to a PMIC connector on `main_pcb`. Line-flow S3 says route+connect the battery FPC during battery placement, but `main_pcb` is not present until S6 and the split interconnect not until S11. Connecting a non-existent connector is impossible; if the FPC is pre-folded to the S3 routed pose it risks a sub-R0.8 crease before the board arrives. *Mitigation:* defer all battery/PMIC FPC mating to S4 (FPC station); at S3 only tack the service loop into the comb, do not fold to final.
- **G08 / major** — Display FPC bend keepout (`display_fpc_bend_keepout`) clears at 1.226 mm in *final* pose, but the display is dropped +Z at S15 over an already-populated bay; the FPC must fold around the top island as the panel seats. Final-pose clearance does not prove the transient bend radius during the fold. *Mitigation:* S4-FIX-004 routing combs must pre-form the display FPC to >= R1.0 and hold it during S15 seat; add an in-process FPC bend-radius gauge at S1/S15 (already a listed S1 gauge).
- **G09 / major** — Split-board side service loop (`split_interconnect_side_flex`) reports 0.0 mm clearance to neighbors at final pose. Zero clearance means any over-insertion or vibration pinches it between PCB and side frame. *Mitigation:* relieve the side-frame inner wall locally (add >= 0.3 mm channel) or hold the loop in the S4 comb until after S17 snap; re-run checker after relief.
- **G10 / minor** — Four FPC families (display, split top, split bottom, battery/PMIC side loop) all mate at S4 with audible+AOI click. Risk of wrong-tail-into-wrong-connector since top/bottom tails are similar. *Mitigation:* poka-yoke via different connector pin-counts/widths or keyed shrouds (see G21).

### 4. Connector mating

- **G11 / major** — B2B/ZIF connectors (`split_interconnect_top/bottom_connector` at z -1.7..-0.8, `display_fpc_connector` -1.575..-0.425) seat with +Z force (down toward the pallet in back-up build). Backing is the `main_pcb` (z -2.5..-1.7) supported on bosses and back shell below — backing exists, good. But mate happens at S4 *after* the PCB is only 4-of-6 screwed (S2); an unscrewed quadrant can flex and half-mate. *Mitigation:* drive all PCB-retaining bosses (incl. 7,8 mid) at S2 before S4; require post-mate continuity (already CTQ `*_continuity`) plus seat-height AOI to catch half-mate.
- **G12 / major** — Half-mate / mis-mate of the two split-interconnect tails is the dominant S4 failure mode (S4 FPY 97.8%, lowest manual station). *Mitigation:* locking-probe seat confirmation + per-connector continuity gate is specified; add seat-force monitoring on the probe.
- **G13 / minor** — No discrete SoM/board-to-board stack beyond the split interconnect; SoC/PMIC/radio are reflowed under shield cans on the single `main_pcb`. No mezzanine mate risk. *Mitigation:* none.

### 5. Adhesive / bonding

- **G14 / major** — Cover-glass + display perimeter bond (S15/16, `screen_adhesive_*`, `screen_cover_glass`) needs the `screen_bond_clamp_frame` fixture and 90 s cure in the inline tunnel between S1 and S2. The line-flow places this fixture at S1 but the *sequence* bonds the display at step 15/16 — the cure-tunnel topology (between S1 and S2) does not match a step-15 bond. Cure time (90 s) >> 38 s takt blocks line flow if serialized. *Mitigation:* parallel cure carrier (tunnel already "unmanned, parallel"); reconcile the line-flow station map so the bond/cure station is physically where step 15/16 occurs, not S1.
- **G15 / major** — Battery is PSA-bonded at S3 (8 N, 3 s). No pull-tab / rework access is modeled. A failed cell post-bond cannot be removed without prying near the FPC. *Mitigation:* add a stretch-release pull-tab to the battery PSA spec and a tab-access slot in the rib layout; document rework SOP.
- **G16 / minor** — Rear camera cover glass + 4 PSA strips (S2 of sequence) bond into the flush back wall; PSA roller access is from +Z into open shell — clear. *Mitigation:* none.

### 6. Battery

- **G17 / blocker (shared root with G01)** — Swell-void foam shelf unplaced (G01). Without it the 0.6 mm void is empty air and the cell can migrate/swell into the back wall; the DROP-2 force-limiting assumption (0.6x coupling) is invalid. *Mitigation:* as G01.
- **G18 / major** — Battery insertion (S3, +Z drop between `orange_battery_left/right_rib`) with its FPC attached risks creasing the tail under the cell. *Mitigation:* place cell first, route FPC last into the S4 comb; never drop the cell onto its own folded tail. Confirms G07 sequencing.
- **G19 / minor** — Pull-tab/FPC orientation not keyed in CAD (single rectangular pouch). *Mitigation:* mark a printed orientation fiducial + jig hard-stop on S3-FIX-003.

### 7. Alignment

- **G20 / major** — Rear (`rear_camera_alignment_pin`) and front (`front_camera_alignment_pin`) alignment pins exist as fixtures (S6 probes in the fixture table) but the pins are *test-station* probes, not *placement* aids — yet the cameras are placed at sequence steps 4 and 14. Placement at S2/S4 region has no datum pin. *Mitigation:* promote `evt_fixture_*_camera_alignment_pin` to the placement nests at the camera-drop steps; register module corner to pin within ±0.05 mm.
- **G21 / major** — Button cap-to-switch alignment: caps (`power_button_cap` x +38.55..40.55; `volume_button_cap` x -40.55..-38.55) are side-inserted at S18/19 onto tactile switches reflowed on the PCB. Cap travel 0.20 mm with 0.30 mm proud; lateral misregistration misses the dome. *Mitigation:* labyrinth rails (`*_labyrinth_upper/lower_rail`) provide the slide datum; add a side-key insertion tool hard-stop and post-insert force/travel check (`evt_fixture_button_force_probe` at S6).

### 8. Acoustic / seal

- **G22 / major** — Multiple meshes/gaskets placed at S9/S13 (`bottom_speaker_dust_mesh`, `*_microphone_mesh_*`, `top_microphone_mesh`, `handset_acoustic_mesh`, `earpiece_gasket`, `usb_c_perimeter_gasket_*`). S9 reports the lowest insertion clearance in the whole build (0.500 mm) — meshes can be mis-seated or pinched at S17 closure. Wave-2 set an 8 µm compression-set CTQ. *Mitigation:* `evt_fixture_bottom_acoustic_leak_mask` + `evt_fixture_earpiece_leak_mask` (in fixture table) leak-test at S6; PSA-locate meshes before S17; verify no mesh lifts during snap platen press.
- **G23 / minor** — USB-C drip-lip + drain shelf + 4 perimeter gaskets (S7/S8) seat around the receptacle; gasket mis-seat breaks IP54. *Mitigation:* gasket pick+seat nest with vision confirm; `evt_fixture_usb_c_insertion_gauge` at S6.

### 9. Button subassembly

- **G24 / major** — Cap + elastomer gasket + labyrinth rails install order: rails are molded into the side frame (`SIDE_FRAME_MOLDED`), so the cap+gasket can only enter at S18/19 *after* S17 closure, side-loaded ±X through the frame aperture (2.5 mm travel). Power side clearance is tight (0.585 mm). Pre-load risk: cap proud 0.30 mm > 0.20 mm travel ensures no rest pre-load (good, per design rev §5). *Mitigation:* side-key insertion tool with elastomer-retention; verify no gasket roll-over on insert.
- **G25 / minor** — Volume is a single cap in CAD (`volume_button_cap`, one 21 mm-long part), not a two-dome rocker with separate up/down domes — so two-dome alignment is N/A as modeled, but if production uses a rocker the single-cap CAD under-specifies dome registration. *Mitigation:* confirm volume is single-action or model the rocker pivot; flag to ME.

### 10. ESD / handling

- **G26 / major** — ESD-sensitive active parts (SoC/PMIC/radio under `*_shield_can`, `antenna_aperture_tuner`, `rear_camera_module`, `front_camera_module`, `rear_flash_led`/AW36515 driver) are exposed open-faced from S2 through S17 close. Line-flow specifies an anti-static mat throughout but no per-operator wrist-strap/ionizer call-out at the camera/LED drop steps. *Mitigation:* wrist-strap continuity interlock at S2/S4/S9/S14; ionizer over the open-back conveyor; ground the pallet PEEK bosses path.

### 11. Test access

- **G27 / major** — Functional test (S6) runs *after* S17 side-frame closure and S15/16 cover-glass bond. All probing is then through external apertures (USB-C, buttons, mics, cameras) — no pogo access to internal test pads once closed. A board-level fault found at S6 requires destroying the bonded glass. *Mitigation:* add an in-line pre-close ICT/boundary-scan station after S6 (PCB) equivalent *before* S15 bond; expose flashing/JTAG pads reachable from the open back; gate continuity at S2/S4 (already CTQ).
- **G28 / minor** — Programming/flashing: no explicit flash station; assumed via USB-C at S6. *Mitigation:* confirm bootloader flash over USB-C pre-bond, else add open-back pogo flash before S15.

### 12. Rework / disassembly

- **G29 / major** — Closure is mixed snap (8 hooks) + screw (should be 10). Snaps are reworkable but the cover glass is OCA-bonded (S16) and battery is PSA-bonded (S3) — both destructive to open. First-pass S6 yield 95.5% feeds a rework loop that, post-bond, is effectively scrap for display/battery faults. *Mitigation:* keep all electrical faults catchable pre-bond (G27); design snap hooks for >= 5 open/close cycles; battery stretch-release tab (G15).
- **G30 / minor** — Side-frame snaps (`orange_snap_hook_1..8`) pull-tested 1-in-20 at >= 6 N; repeated rework may fatigue them. *Mitigation:* scrap-after-N-opens rule in rework SOP.

### 13. Poka-yoke

- **G31 / major** — Cameras (`rear_camera_module` 10x10, `front_camera_module` 6.5x6.5) are near-square — rotational mis-orient (90°/180°) is plausible without keying. *Mitigation:* asymmetric module corner cut + matching pocket key; vacuum-pick orientation vision; alignment pin (G20).
- **G32 / major** — Battery pouch is a plain rectangle; up/down (FPC exit) flip possible. *Mitigation:* rib asymmetry + tab-side hard stop (G19).
- **G33 / minor** — FPC tails (top vs bottom split) interchangeable risk (G10). *Mitigation:* keyed connector widths/pin-counts.
- **G34 / minor** — Power vs volume caps are different lengths (12 vs 21 mm) and opposite sides — inherently keyed by side and length. *Mitigation:* none; retain side-specific insertion tools.

### 14. Contamination

- **G35 / major** — Display bond (S15/16) and both camera windows are particle-sensitive; cameras are placed at S4/S14 and live open through many downstream steps, accumulating dust before the glass closes over them. *Mitigation:* localized laminar-flow hood over S14->S16; ionized blow-off + tack-roll immediately before display bond; particle count CTQ at the bond station; rear camera cover glass bonded early (S2) protects the rear optic — keep front optic covered until S15.
- **G36 / minor** — Snap-platen press (S5, 25 N) and torque driving generate particulate near open optics if sequenced after S14. As sequenced S17 close is after S15/16 bond, so optics are covered — acceptable. *Mitigation:* none.

## Tally

- Total gotchas: **36** (G01–G36).
- **Blocker: 3** (G01, G04, G17 — note G17 shares G01's root cause).
- **Major: 20** (G02, G05, G07, G08, G09, G11, G12, G14, G15, G18, G20, G21, G22, G24, G26, G27, G29, G31, G32, G35).
- **Minor: 13** (G03, G06, G10, G13, G16, G19, G23, G25, G28, G30, G33, G34, G36).

## Verdict

There are **BLOCKER-severity gotchas**, but they are *process/coverage* blockers, not geometric impossibilities. The CAD passes the swept-insertion checker (0 trapped, fastener+FPC pass) and the boolean-interference gate (0 clashes). The phone is **not yet assemblable as documented** because:

1. **G01/G17** — the battery swell-void foam pad is a real BOM part with no assembly step and would be trapped behind the bonded cell. The line cannot install it as sequenced.
2. **G04** — four of the ten structural screw bosses are unmodeled in the sequence and unverified for driver access; the line-flow installs only 6 screws, leaving the drop-hardened structure under-fastened.

Both are closable without geometry change: add a foam-pad step ahead of the battery, and extend the fastener step + checker coverage to all 10 bosses (then re-run `check_e1_phone_assemblability.py`). With those two sequence fixes plus the 20 major mitigations (fixtures already exist for most: `screen_bond_clamp_frame`, `usb_c_insertion_gauge`, `button_force_probe`, `rear/front_camera_alignment_pin`, `bottom_acoustic_leak_mask`, `earpiece_leak_mask`), **the e1-phone is assemblable.**
