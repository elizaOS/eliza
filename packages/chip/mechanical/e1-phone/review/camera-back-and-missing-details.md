# E1 phone — camera↔back deep dive + missing-details hunt

evidence_class: `cad_estimate_for_evt_planning, not_measured_hardware`

Scope: rear-camera/torch optical+mechanical path verification, and an audit of
production-phone CAD parts against the 123-entry assembly manifest. All numbers
are read from `out/assembly-manifest.json` bounds and the fresh OCP boolean
interference run (`check_e1_phone_boolean_interference.py`, 2026-05-21,
11/11 scopes PASS, 0 unintentional clashes, 459 B-rep pairs evaluated).

Reference frame: origin mid-plane, +Z toward screen. Back outer plane Z = -5.9 mm,
back wall 1.15 mm, back inner wall Z = -4.7 mm. Front cover-glass outer face +5.9 mm,
inner face +5.2 mm. Device depth 11.8 mm (live geometry; the 12.7 mm figures in
older review revs are superseded by the manifest).

---

## PART A — Camera ↔ back path (outside-in)

### Rear camera optical column

| Interface | Manifest evidence | Verdict |
|---|---|---|
| `rear_camera_lens_window` flush | Z = [-5.9, -5.35], outer face at -5.9 = back outer plane | FLUSH, never proud |
| `rear_camera_cover_glass` (insert) | 9.2×9.2×0.55, Z = [-5.9, -5.35], coplanar | FLUSH |
| Window→shell seal | `rear_camera_cover_adhesive_{top,bottom,left,right}` all 4 sides present, 0.16 mm thick at Z = [-5.35, -5.19] bonding insert back face to shell | SEALED (adhesive) |
| Shell aperture vs cover glass | boolean: `orange_back_shell` vs `rear_camera_cover_glass` gap 0.7 mm, intersection 0.0 mm³ | wall clears glass |
| `rear_camera_shell_aperture` (the molded hole) | 10.6×10.6, i.e. cover-glass 9.2 + ~0.7 mm wall land per side | OK |
| Module burial | `rear_camera_module` back face Zmin = -4.3 mm vs inner wall -4.7 → **0.4 mm boolean burial** (0.45 analytic) | BURIED ≥0.3 |
| Module vs shell wall | boolean min gap 0.5 mm, intersection 0.0 | clears |
| Stray-light baffle | `rear_camera_light_baffle_{top,bottom}` only (8.3×0.35×0.55) | partial — see gap B-1 |

Lens optical aperture: `rear_camera_lens_window` clear aperture is **6.8 × 6.8 mm =
exactly the 6.8 mm lens diameter** — zero radial margin between lens OD and the
window clear opening. The component-optical review assumed a 9.2 mm aperture
(1.2 mm margin); the live window is the 6.8 mm inner clear, with the 9.2 mm being
the glass insert outline. Flag B-2.

### Rear torch / flash

| Interface | Manifest evidence | Verdict |
|---|---|---|
| `rear_flash_led_window` flush | 1.6×1.6×0.55, Z = [-5.9, -5.35], outer face at -5.9 | FLUSH |
| Window→shell seal | no dedicated flash-window adhesive part (camera window has 4; flash window has none) | gap B-3 |
| `rear_flash_led` burial | back face Zmin = -4.55 vs inner wall -4.7 → **0.15 mm burial** | BURIED ≥0.1 |
| Flash↔camera spacing | window-center to lens-window-center = **8.1 mm** (≥6.0 target, ≫5.0 floor) | PASS |
| `rear_flash_camera_septum` | opaque PC wall 0.6 mm thick, Z = [-4.75, -2.65], between flash pipe and camera baffle | PRESENT |

Stray-light path: septum (8.1 mm spacing) + camera top/bottom baffles + 4-side
camera adhesive seal. The only un-baffled faces of the camera column are its
left/right walls, which face the dark interior / battery, not the flash — the
flash side is covered by the septum. No light-leak path to the lens is open.

### Front camera

| Interface | Manifest evidence | Verdict |
|---|---|---|
| `front_camera_under_glass` window | 3.4×0.35×3.4, Z = [4.25, 7.65] | present (matches 3.4 mm lens) |
| `front_camera_black_mask_window` aperture | 5.0×5.0×0.12 at Z = [5.76, 5.88] (in cover-glass ink plane) | aperture 5.0 > 3.4 lens OD, OK |
| Module seat | `front_camera_module` 6.5×6.5×3.2, Z = [-0.6, 2.6], behind display band | buried/fits |
| Earpiece neighbor | `earpiece_gasket` + `handset_acoustic_mesh` present | sealed |
| Under-glass→cover-glass seal | no adhesive/foam ring bonding `front_camera_under_glass` to the black-mask aperture | gap B-4 |

### PART A verdict

- **Flush back: HOLDS.** Max solid protrusion past the back outer plane = 0.0 mm
  (boolean). Both windows coplanar at Z = -5.9 mm. Only envelope/void parts
  (`rear_camera_shell_aperture` 0.055, `rear_flash_shell_aperture` 0.055,
  `service_label_recess` 0.205) excurse, and they are voids, not solid.
- **Sealed: REAR CAMERA yes** (4-side adhesive), **REAR FLASH no dedicated seal**
  (B-3), **FRONT CAMERA no under-glass bond ring** (B-4).
- **Buried: YES** — rear camera 0.4 mm, flash 0.15 mm, both inside the inner wall.
- **No light-leak path** to the rear lens: septum + spacing + baffles + camera
  4-side seal close the flush-coplanar-window crosstalk risk the optical review
  flagged. Residual: rear camera has no left/right baffle wall (B-1), and the
  6.8 mm lens window has zero radial margin (B-2).

---

## PART B — Missing-details hunt (vs 123-part manifest)

EMI/RF, retention, glass-edge, and acoustic-mesh families are well covered. The
gaps cluster in **thermal**, **display EMI/grounding**, **structural mid-plate**,
**antenna RF contacts**, and **flex/connector hardware**.

| Item | Present? | Severity | Note |
|---|---|---|---|
| EMI shield cans (SoC/PMIC/modem-RF) | YES | — | `soc_shield_can`, `pmic_shield_can`, `radio_shield_can` |
| Thermal spreader / graphite / SoC thermal pad | NO | HIGH | no `thermal/graphite/spreader` part; 43 °C skin target unbacked by any conductive path |
| Display ground / EMI foam, conductive gasket | NO | HIGH | no conductive foam between display metal frame and shield/chassis ground |
| Mid-frame / display bracket / metal stiffener | NO | HIGH | design is plastic shell + plastic side frame only; no mid-plate. Drop SF relies on bosses+ribs; bend stiffness unbacked |
| Cover-glass perimeter adhesive | YES | — | `screen_adhesive_{4}` (1.0 mm, 0.18 mm OCA frame) |
| Cover-glass perimeter cushion | YES | — | `glass_perimeter_cushion_{4}` (PORON, 0.25 mm) |
| Rear lens-window adhesive seal | YES | — | `rear_camera_cover_adhesive_{4}` |
| Antenna carriers / spring contacts / pads | NO | HIGH | only RF keepouts + `antenna_aperture_tuner`; no LDS carrier, no spring-finger/pogo feed contacts |
| Screw bosses (10) | YES | — | `orange_screw_boss_1..10` |
| Corner gussets | YES | — | `orange_corner_rib_1..4` + `_leg` (4 gussets) |
| Battery adhesive / pull-tab / compliant shelf | PARTIAL | MED | `battery_back_void_foam_pad` (shelf) present; no mounting adhesive layer, no pull-tab |
| FPC stiffeners | NO | MED | display/split-flex tails modeled, no stiffener parts |
| ZIF connector actuators | NO | LOW | connectors modeled as blocks; actuators are vendor part detail |
| Waterproof mesh (speaker/mic/earpiece) | YES | — | `bottom_speaker_dust_mesh`, `bottom_microphone_mesh_{1,2}`, `top_microphone_mesh`, `handset_acoustic_mesh` |
| Notification / status LED + light pipe | NO | LOW | no notification LED in design; acceptable to omit, but note absence is a product decision |
| Proximity / ambient-light sensor (front) | NO | HIGH | no `proximity/als/ambient` part; nearly every phone has prox (call screen-off) + ALS (auto-brightness). Likely real omission |
| Accelerometer / gyro / magnetometer IMU | NO | MED | no IMU footprint (electrical, on PCB) — note for board, no CAD volume needed |
| LRA vibration isolation | NO | MED | `haptic_lra` seated rigidly; no isolation grommet/foam → buzz into shell + drop shock to actuator |
| Front-cam under-glass bond ring | NO | MED | B-4: `front_camera_under_glass` not bonded/sealed to black-mask aperture |
| Rear-camera flash-window adhesive | NO | MED | B-3: flash window has no seal part (camera window does) |
| Rear-camera L/R light baffle | NO | LOW | B-1: only top/bottom baffles modeled |

### Missing-detail counts

- HIGH: 5 — thermal spreader/pad; display EMI ground foam; mid-frame/stiffener;
  antenna spring contacts/carrier; proximity+ALS sensor.
- MED: 6 — battery mounting adhesive/pull-tab; FPC stiffeners; IMU (electrical);
  LRA vibration isolation; front-cam under-glass bond; flash-window seal.
- LOW: 3 — ZIF actuators; notification LED/light-pipe; rear-cam L/R baffle.

### Real gap vs acceptable-to-omit at EVT

- **Real gaps needing a CAD part (do before DVT):** thermal spreader/SoC pad
  (HIGH — only path to the 43 °C target), display EMI/ground foam (HIGH —
  emissions + ESD), antenna spring contacts/carrier (HIGH — RF feed is a keepout
  with no metal-to-board contact modeled), proximity+ALS sensor + its front
  aperture (HIGH — standard phone behavior, currently absent). A mid-frame
  (HIGH) is a larger architecture decision: if the plastic shell + side frame +
  10 bosses + gussets pass drop/bend, a metal mid-plate can be skipped, but the
  reviews never validated panel-bend stiffness without one — call it out.
- **Real but EVT-deferrable:** LRA isolation grommet, battery mounting adhesive +
  pull-tab, FPC stiffeners, front-cam under-glass bond, flash-window seal.
- **Acceptable to omit / electrical-only:** IMU + ZIF actuators (vendor/board
  detail, no enclosure volume), notification LED (product decision),
  rear-cam L/R baffle (faces dark interior, septum handles the flash side).
