# E1 Phone Assembly Line Flow

Owner: E1 manufacturing engineering | EMS partner: Shenzhen Bao'an contract assembly | Date: 2026-04-28

Production assembly flow for the E1 orange PC+ABS slab phone (78 x 153.6 x 11.8 mm, 185 g target, dual-injection orange back shell + side frame). 8 manned stations + 1 unmanned cure tunnel.

## Line Topology

- Layout: linear conveyor, 8 manned stations, 1 inline UV/thermal cure tunnel between S1 and S2, lift-and-locate pallet per unit, anti-static mat throughout.
- Pallet: machined aluminum with PEEK locating bosses; back-shell B-side faces up; serial QR scanned by Honeywell 1900 at S1 entry and S8 exit.
- Takt time target: 38 s/unit (matches molding 26.4 s + transfer / inventory buffer).
- Daily throughput at 90% OEE: 1,704 units/shift (8 h * 3600 / 38 * 0.90) per single line.
- Annual at 250 working days, 2 shifts/day, 90% OEE: ~852 000 units/year (covers 250k design volume with margin for yield ramp and downtime).
- **Headcount per shift:** 10 operators + 1 IPQC engineer + 1 line lead + 1 floor support = 13 people per line per shift.

## Station Detail

### Station 1 — Display Bond

- **Operations:** Place orange_back_shell B-side-up on pallet. Apply screen_adhesive_top/left/right/bottom (pre-cut OCA, 1.0 mm wide x 0.18 mm). Place display_lcm into shell with cover_glass_top. Drop into bond fixture, clamp 90 s at 22 C 45% RH.
- **Fixture:** `evt_fixture_screen_bond_clamp_frame.stl` (S1-FIX-001 production rev)
- **Gauges:** cover_glass xy alignment camera, adhesive compression dial indicator, FPC bend radius gauge, Konica CS150 luminance probe
- **Cycle:** 32 s manned + 90 s cure tunnel (parallel)
- **Headcount:** 1 operator
- **CTQ measurements:** cover_glass_xy_mm (+/- 0.15), adhesive_compression_mm (0.135 = 25% of 0.18), fpc_bend_radius_mm (>= 1.0), luminance_cd_m2 (>= 450), touch_grid_pass
- **Stop rules:** screen lift, FPC overbend, touch-grid failure, luminance outlier
- **Expected yield:** 98.5%

### Station 2 — PCB Load

- **Operations:** Operator picks routed `main_pcb` (single board, split-flex variant), seats into back-shell PCB pocket aligning against screw bosses 1 and 4 as datum. Verify SOC, PMIC, and radio shield cans seated. Insert SIM tray placeholder. Drive the pre-battery M1.4 fasteners on the torque map, including the cell-adjacent bosses before the pouch is placed.
- **Fixture:** PCB datum nest S2-FIX-002 (alignment to bosses 1/4)
- **Gauges:** torque driver Wera 7440 calibrated 2025-12, AOI for shield seating
- **Cycle:** 36 s
- **Headcount:** 1 operator
- **CTQ:** top_connector_seated, bottom_connector_seated, split_flex_continuity_ohm, screw_torque_ncm (18 +/- 2)
- **Stop rules:** mis-seated connector, flex continuity fail, shield can tilt
- **Expected yield:** 99.0%

### Station 3 — Battery

- **Operations:** Bond `battery_back_void_foam_pad` to the inner back wall first. Peel battery pouch adhesive backer. Place the 5.6 mm / 5727 mAh-class pouch into the battery window between `orange_battery_left_rib` and `orange_battery_right_rib`. Press 8 N for 3 s to set bond. Tack the battery service loop in the routing comb; final battery/PMIC FPC mating happens at Station 4 after `main_pcb` is present.
- **Fixture:** battery placement jig S3-FIX-003 (pneumatic 8 N press)
- **Gauges:** placement camera, cable pinch visual aid
- **Cycle:** 28 s
- **Headcount:** 1 operator
- **CTQ:** battery_window_fit_visual, battery_to_pcb_gap_mm (>= 0.5), cable_pinch_visual_pass, battery_voltage_initial_v (3.7-3.95)
- **Stop rules:** battery interference, cable pinch, voltage out of band, adhesive lift
- **Expected yield:** 99.2%

### Station 4 — FPC Connections

- **Operations:** Connect display FPC to display_fpc_connector. Connect split_interconnect_top_flex_tail to top board island connector. Connect split_interconnect_bottom_flex_tail to bottom island. Mate the battery/PMIC service loop after `main_pcb` is present. Connect haptic_lra leads to PMIC. Connect side_key_power_flex_tail and side_key_volume_flex_tail to power/volume tactile switches. Verify all connector clicks via audible+AOI confirmation.
- **Fixture:** FPC routing combs S4-FIX-004; locking probe to confirm seating
- **Gauges:** FPC continuity tester (Goldensea TR-9000), AOI on connector seating
- **Cycle:** 42 s (longest manual station)
- **Headcount:** 2 operators (parallel left/right)
- **CTQ:** display_fpc_continuity, top/bottom_split_flex_continuity, haptic_continuity, button_flex_continuity, no_overbend
- **Stop rules:** any continuity failure, FPC bend below R0.8, mis-mate
- **Expected yield:** 97.8%

### Station 5 — Side Frame Snap

- **Operations:** Place orange_side_frame onto back-shell perimeter, align 8 snap hooks (`orange_snap_hook_1..8`) to side-frame catches. Press via hydraulic platen at 25 N for 2 s to seat all 8 snaps simultaneously. Verify all 10 M1.4 screw bosses (`orange_screw_boss_1..10`) have torque-map coverage and drive any post-battery perimeter fasteners to 22 N-cm. Verify gap/flush around perimeter.
- **Fixture:** side-frame snap platen S5-FIX-005 (25 N hydraulic, 8-point load distribution)
- **Gauges:** snap retention pull-test rig (1 of 20 sample), feeler gauge 0.05-0.50 mm, torque Wera 7440
- **Cycle:** 30 s
- **Headcount:** 1 operator
- **CTQ:** snap_retention_n (>= 6 N each), screw_torque_ncm (22 +/- 3), gap_flush_mm (<= 0.15)
- **Stop rules:** snap hook fracture, screw strip, gap > 0.15 mm
- **Expected yield:** 98.0%

### Station 6 — Functional Test

- **Operations:** Place unit in functional test rack. Auto-test: display bring-up, touch-grid scan, both cameras (rear + front) capture and IQ check, speaker SPL sweep, mic SNR, earpiece, USB-C insertion + power negotiation, button force/travel per `evt_fixture_button_force_probe`, haptic vibration, radio (cellular RG255C + WiFi/BT 2EA) smoke test, IMU/sensor enumeration. Total functional test ~70 s, but rack runs 4 units in parallel so per-unit time ~18 s station-blocked + 52 s rack-internal.
- **Fixture:** function station FS-FA-01 (4-up rack, automated probes)
- **Gauges:** AP525 audio analyzer, USB-C insertion gauge `evt_fixture_usb_c_insertion_gauge`, button force probe `evt_fixture_button_force_probe`, RF test harness
- **Cycle:** 18 s station / 70 s test
- **Headcount:** 1 operator (loads + unloads, monitors)
- **CTQ:** all functional pass criteria
- **Stop rules:** any functional fail = NCR + rework loop
- **Expected yield:** 95.5% (first-pass; rework recovers most)

### Station 7 — Cosmetic QC

- **Operations:** Move unit to D65 lightbox under ISO 3664 P2 viewing. Visual cosmetic audit: scratches, dings, contamination, gate vestige visibility, gap/flush perimeter, snap-line on side frame. Spot-check color via Konica CM-700d on n=1 of 20 (full SPC subgroup on shift boundary). Spot-check gloss via BYK micro-gloss 60 on same sample.
- **Fixture:** D65 lightbox CMF-LB-04
- **Gauges:** Konica CM-700d spectrophotometer, BYK micro-gloss 60
- **Cycle:** 25 s
- **Headcount:** 1 operator + IPQC engineer floats
- **CTQ:** cmf_visual_pass, deltaE-CMC <= 1.2, gloss 12 +/- 3 GU
- **Stop rules:** scratch > 0.3 mm, deltaE > 1.2, dent, missing CMF feature
- **Expected yield:** 98.8%

### Station 8 — Pack

- **Operations:** Apply service label to service_label_recess. Final photo on CMF lightbox (archived with serial in MES). Wrap unit in anti-static bag, insert into retail box with accessories (USB-C cable, paperwork). Carton scan-out via Honeywell 1900.
- **Fixture:** pack-out kitting station S8-FIX-008
- **Gauges:** label position visual aid, scale 0-500 g (verify retail-box mass)
- **Cycle:** 22 s
- **Headcount:** 1 operator
- **CTQ:** label_position, serial_scan_pass, final_photo_artifact, box_mass_total
- **Stop rules:** missing accessory, scan fail, box-mass outlier
- **Expected yield:** 99.5%

## Line Yield Rollup

| Station | First-pass yield |
|---|---|
| S1 Display bond | 98.5% |
| S2 PCB load | 99.0% |
| S3 Battery | 99.2% |
| S4 FPC | 97.8% |
| S5 Side frame | 98.0% |
| S6 Function | 95.5% |
| S7 Cosmetic | 98.8% |
| S8 Pack | 99.5% |
| **Rolled FPY** | **86.9%** |

With rework recovery (>= 90% of S4/S6 fails recoverable), **target final yield 96.5% at PVT**, **98.0% at sustained production**.

## Cycle Time Summary

- Longest manual station: S4 at 42 s -> bottleneck
- Takt achievable: 38 s/unit at S4 with 2 operators in parallel
- Line speed: 1 unit / 38 s = ~95/h theoretical, ~85/h with 90% OEE

## Fixture References (production rev based on EVT)

| EVT fixture | Production rev | Station |
|---|---|---|
| evt_fixture_screen_bond_clamp_frame | S1-FIX-001 | S1 Display bond |
| (PCB datum nest, new for production) | S2-FIX-002 | S2 PCB |
| (battery placement jig, new) | S3-FIX-003 | S3 Battery |
| (FPC routing combs, new) | S4-FIX-004 | S4 FPC |
| (side-frame snap platen, new) | S5-FIX-005 | S5 Snap |
| evt_fixture_usb_c_insertion_gauge | S6 USB probe | S6 Function |
| evt_fixture_button_force_probe | S6 button probe | S6 Function |
| evt_fixture_rear_camera_alignment_pin | S6 camera probe | S6 Function |
| evt_fixture_front_camera_alignment_pin | S6 camera probe | S6 Function |
| evt_fixture_bottom_acoustic_leak_mask | S6 acoustic | S6 Function |
| evt_fixture_earpiece_leak_mask | S6 acoustic | S6 Function |
| (D65 lightbox CMF-LB-04, COTS) | CMF-LB-04 | S7 Cosmetic |
| (pack station, COTS) | S8-FIX-008 | S8 Pack |

## References

- `assembly-build-traveler.json` — station-level traveler schema
- `process-control-plan.json` — control plan and SPC linkage
- `process-control-engineering-report.md` — SPC / AQL details
- `evt-fixtures.json` — EVT fixture manifest
- `evt-inspection-plan.json` — EVT measurement plan
