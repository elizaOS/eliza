# E1 Phone — Exhaustive Assembly-Gotcha Audit (DFA)

evidence_class: `dfa_gotcha_audit_for_evt_planning_not_measured_hardware`
Revision: `evt0-mechanical-cad-flush-back` (swell-camera-seal + wave-2 + thickness rev) | Date: 2026-05-21
Reviewer: senior DFA engineer. Basis: `out/assembly-manifest.json` (123 solids), `review/assembly-verification.{md,json}`, `review/assembly-line-flow.md`, `review/design-change-flush-back.md`, re-run of `scripts/check_e1_phone_assemblability.py`.

## Checker re-run (current state)

```
assemblable=True steps=20 trapped=0 fastener_pass=True fpc_pass=True
```

The checker returns PASS and now covers the previously identified local CAD/process blockers:

- **Boss-count coverage fixed.** `check_fastener_access` now enumerates `orange_screw_boss_1..10` plus `orange_snap_hook_1..8`; the generated checker result has `fastener_pass=True`.
- **Foam-pad insertion fixed.** `battery_back_void_foam_pad` is now its own assembly step before `battery_pouch`, and the swept insertion checker reports 0 trapped parts.
- **Line-flow drift fixed locally.** The line-flow now calls out the 11.8 mm package, the back-void foam pad before battery placement, deferred battery/PMIC FPC mating at S4 after the PCB exists, cell-adjacent pre-battery fastener drive, and 10-boss torque-map coverage.
- **Split-interconnect FPC clearance fixed.** The FPC route checker now treats the side service loop and its top/bottom tails as one mating interconnect assembly; the re-run reports 0.56 mm side-loop clearance and 0.25 mm clearance on each tail, with no pinching parts.

Remaining open items below are process, yield, fixture, and physical-validation mitigations. They do not contradict the current CAD swept-insertion result.

## Gotcha register

Severity: **blocker** = phone cannot be built / a real part has no install path; **major** = high defect/yield/safety risk needing a fixture or sequence change; **minor** = cosmetic/efficiency/handling refinement.

### 1. Insertion order & trapped parts

- **G01 / mitigated blocker** — `battery_back_void_foam_pad` must be placed on the back inner wall *before* the battery. *Mitigation complete locally:* the checker now has a dedicated foam-pad step ahead of `battery_pouch`, and Station 3 bonds the foam before pouch placement.
- **G02 / major** — Two-sided build risk is avoided by the chosen single-side (back-up) order, but display+cover-glass bond (S15/16) happens *before* side-frame closure and screws (S17). A display reject at S6 functional test forces destroying the cover-glass bond to reach the PCB. *Mitigation:* keep test points accessible pre-close (see G24) so most rejects are caught before the irreversible bond; treat post-bond PCB rework as scrap-class.
- **G03 / minor** — `antenna_aperture_tuner` (Qorvo QPC1252Q, on PCB at z -1.85..-1.35) arrives with `main_pcb` as a reflowed component, so it is not separately trapped — but it is not called out in S2 AOI. *Mitigation:* add tuner presence/orientation to S2 AOI shield/component check.

### 2. Tool & driver access

- **G04 / mitigated blocker** — Bosses 1..10 must be driven and access-verified. *Mitigation complete locally:* `check_fastener_access` now checks all 10 bosses plus 8 snap hooks, and line-flow uses 10-boss torque-map coverage.
- **G05 / mitigated major** — Bosses 5/6 (x ±27, y +18, z -5.3..-2.5) sit beside the battery (battery x ±32), so driving them after the pouch is bonded risks a slipped driver puncture. *Mitigation complete locally:* Station 2 now drives the pre-battery fasteners, including the cell-adjacent bosses, before pouch placement; Station 5 retains 10-boss torque-map verification for any post-battery perimeter fasteners.
- **G06 / minor** — FPC ZIF/B2B seating at S4 is by "locking probe"; driver and probe share the open-back approach but at different islands. No reach conflict found (connectors at z -1.7..-0.4, well above PCB). *Mitigation:* none required; retain locking-probe AOI confirmation.

### 3. FPC handling

- **G07 / mitigated major** — Battery FPC routes to a PMIC connector on `main_pcb`; mating it during S3 battery placement would target a connector that is not present yet and could crease the tail. *Mitigation complete locally:* S3 now only tacks the service loop in the routing comb, and S4 explicitly mates the battery/PMIC service loop after `main_pcb` is present.
- **G08 / major** — Display FPC bend keepout (`display_fpc_bend_keepout`) clears at 1.226 mm in *final* pose, but the display is dropped +Z at S15 over an already-populated bay; the FPC must fold around the top island as the panel seats. Final-pose clearance does not prove the transient bend radius during the fold. *Mitigation:* S4-FIX-004 routing combs must pre-form the display FPC to >= R1.0 and hold it during S15 seat; add an in-process FPC bend-radius gauge at S1/S15 (already a listed S1 gauge).
- **G09 / mitigated major** — Split-board side service loop (`split_interconnect_side_flex`) previously reported 0.0 mm clearance because the checker counted the same split-interconnect top/bottom flex tails as non-mating neighbors. *Mitigation complete locally:* the route mate set now includes the side loop plus both tails as one interconnect assembly; re-run shows side loop 0.56 mm clearance and both tails 0.25 mm, with no pinching parts.
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

- **G17 / mitigated blocker (shared root with G01)** — Swell-void foam shelf must be present before battery placement. *Mitigation complete locally:* same foam-pad step as G01; swept insertion passes.
- **G18 / mitigated major** — Battery insertion (S3, +Z drop between `orange_battery_left/right_rib`) with its FPC folded under the cell risks creasing the tail. *Mitigation complete locally:* S3 places and bonds the cell first, tacks the service loop in the comb only, and defers final FPC mating to S4.
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
- **Blocker: 0**. Former blockers G01, G04, and G17 are locally mitigated in the checker/line-flow.
- **Major: 16** (G02, G08, G11, G12, G14, G15, G20, G21, G22, G24, G26, G27, G29, G31, G32, G35).
- **Minor: 13** (G03, G06, G10, G13, G16, G19, G23, G25, G28, G30, G33, G34, G36).

## Verdict

There are no remaining local CAD assembly blockers in this audit. The current CAD passes swept insertion with 20 steps, 0 trapped parts, all 10 screw bosses plus 8 snap hooks access-checked, and FPC routing unpinched. The remaining major gotchas require process controls, fixtures, or physical build evidence before release.
