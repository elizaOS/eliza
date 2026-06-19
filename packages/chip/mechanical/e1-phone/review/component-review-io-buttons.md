# E1 phone EVT review: I/O and button components

Revision under review: `evt0-mechanical-cad-flush-back` (78.0 x 153.6 x **11.8** mm, flush flat
back, 1.15 mm wall). Scope: power button, volume button, USB-C port. Specialist:
mechanical / electromechanical EVT design review. Evidence: real supplier datasheets and
LCSC pricing pulled live (sources at end). Quantity basis: **@100k**, LCSC unit price (the
listed price-break floor; >=100k typically negotiated 10-20% under the listed break, used
here only as a documented ceiling).

Verdicts up front:

| Component | Verdict | Recommended standard MPN | Source | Unit @100k (ceiling) |
|---|---|---|---|---|
| Power button | MANUFACTURABLE w/ corrections | **XKB TS-1187A-B-A-B** (LCSC C318884) | LCSC / JLCPCB basic | **~$0.011** |
| Volume button | MANUFACTURABLE, single SKU w/ power | **XKB TS-1187A-B-A-B** (same SKU) | LCSC / JLCPCB basic | **~$0.011** |
| USB-C port | MANUFACTURABLE | GCT USB4105-GF-A (LCSC C3020560) | LCSC | **~$0.548** |

**Single standardized button SKU (priority deliverable): `XKB TS-1187A-B-A-B`** — one side-push
3.5 x 2.9 x 1.7 mm SMD tact for BOTH power and volume. It is a pin/footprint/form-factor clone
of the Panasonic EVQ-P7 family at ~1/6 the price, is a JLCPCB "Basic" part (no extra feeder
charge, always stocked), and carries the same 160 gf / 1.57 N actuation. Keep Panasonic
EVQ-P7A01P as the qualified second source (drop-in, same footprint).

---

## 1. POWER BUTTON

**As-drawn:** Panasonic EVQ-P7 side-push tactile, "1.6 N, 0.35 mm travel", cap 2.0 x 12 x 1.1 mm
proud 0.30 +/-0.10 mm on +X.

### Standardization decision

The EVQ-P7 family is a legitimate commodity standard (the de-facto side-push phone-button switch),
but it is the *premium-priced* member of that standard. Three real candidates compared:

| Candidate | MPN | Actuation | Pkg (mm) | Force | Travel | LCSC @100k (ceiling) | Notes |
|---|---|---|---|---|---|---|---|
| Panasonic EVQ-P7 | EVQ-P7A01P (C79167) | **side** | 3.5 x 2.9 x 1.7 | 1.6 N | **0.2 mm** | ~$0.071 | Brand standard, qualified, 100k cyc |
| **XKB TS-1187A (REC)** | TS-1187A-B-A-B (C318884) | **side** | 3.5 x 2.9 x 1.7 | 1.57 N (160 gf) | ~0.25 mm | **~$0.011** | EVQ-P7 footprint clone, JLCPCB Basic |
| Alps SKRP | SKRPABE010 (C115360) | **TOP** | 4.2 x 3.2 x 2.5 | 1.57 N | 0.2 mm | ~$0.039 | **REJECT: top-push, wrong axis** |
| C&K KMR2 | KMR221GLFS (C72443) | **TOP** | 3.9 x 2.9 x 1.9 | ~1.96 N | ~0.2 mm | ~$0.33 | **REJECT: top-push + 30x price** |

**Recommendation: switch the BOM standard to XKB TS-1187A-B-A-B**, keep EVQ-P7A01P as the
pin-compatible alternate second source (same 3.5 x 2.9 footprint, same 4-terminal 2+2 tied
SPST-NO, same side actuation). Reject Alps SKRP and C&K KMR2: both are **top-actuated** — they
would require the cap to push down through the back/front face, not the edge, breaking the
side-button mechanism entirely. (Alps does make side-push SKSC/SKSN families, but they are not
the SKRP cited; do not silently substitute.)

### Validation

- **Travel-stack correction (BLOCKER, data fix):** params claim **0.35 mm travel**; the real
  EVQ-P7 / TS-1187A datasheet travel is **0.20 mm** (Alps SKRP also 0.2 mm). The cap-to-switch
  pretravel + over-travel budget must be rebuilt around 0.20 mm, not 0.35. With a 0.2 mm switch
  stroke and a 0.30 mm proud cap, the cap rib needs ~0.05-0.08 mm pre-load gap to the plunger so
  free-state does not pre-actuate, leaving ~0.12-0.15 mm usable press before hard stop. Tight but
  workable; **update `power_button.travel_mm` to 0.20**.
- **Cap-to-switch actuation alignment:** cap 2.0 mm wide (along Z) x 12 mm (along Y) bears on a
  plunger ~1.0 mm wide. Lateral mis-register budget = mold (+/-0.025) + placement (+/-0.05) +
  reflow float (+/-0.03) ~ **+/-0.11 mm**; against a 2.0 mm cap face vs ~1.0 mm plunger this keeps
  >=0.39 mm overlap each side. PASS. Require a centering boss/rib on the cap inner face.
- **Gasket / labyrinth seal (IP54):** the EVQ-P7 / TS-1187A switch itself has **NO IP rating** —
  confirmed from datasheet. IP54 must be delivered by the cap + housing, not the switch. Required:
  perimeter labyrinth (>=2 ridge/groove pairs, >=0.4 mm overlap) OR a thin TPU/silicone gasket
  captured under the cap flange, compression 15-25%. Document this as the sealing element.
- **Rib / pressure limit:** validation cap is `button_pressure_limit_n_per_mm2: 0.2`. 1.6 N over
  the cap rib contact must spread to >=8 mm^2. The 2.0 x 12 mm cap easily exceeds this; ensure the
  internal actuation rib (not the whole cap) presents >=8 mm^2 to the plunger or use a domed boss.
- **Wake GPIO:** SPST-NO, 2+2 internally-tied terminals; wire COM_A to a wake-capable GPIO with
  internal/external pull-up, COM_B to GND, 10-100 nF debounce. Standard. PASS.

**Margins/tolerances (mm):** lateral register +/-0.11 (overlap margin >=0.39 each side); cap proud
0.30 +/-0.10; aperture-to-cap gap should mirror `usb_c_aperture_clearance` style at 0.20 +/-0.10.
**Spacing/neighbor:** +X edge, isolated from -X volume rocker — no interaction. **Occlusion:** none;
single proud cap on a clean edge. **Open issues:** (1) travel data fix 0.35->0.20 mm; (2) explicit
gasket/labyrinth callout for IP54; (3) free-state pre-load gap spec.

---

## 2. VOLUME BUTTON

**As-drawn:** same EVQ-P7 family, cap 2.0 x 21 x 1.1 mm rocker on -X, 1.5 N, 0.35 mm travel.

### Standardization decision

**Confirmed: use the SAME single SKU as power — XKB TS-1187A-B-A-B.** A volume rocker is built from
**two** of the identical side-push switches under one long see-saw cap (up = top dome, down = bottom
dome). No second part number is introduced; BOM line is one MPN x (1 power + 2 volume) = **3 pcs of
TS-1187A per phone**, plus EVQ-P7A01P as alternate. This is the cleanest possible button BOM.

### Validation

- **Rocker pivot:** the 21 mm cap pivots on a central living-hinge or molded pin so that pressing one
  end depresses one dome without the other. Pivot must sit on the cap centerline between the two
  switches; switch pitch should be ~12-15 mm so each end gets clear mechanical advantage. Specify the
  inter-switch pitch in params (currently absent).
- **Dual-dome:** two TS-1187A at 0.20 mm travel each (data fix, same as power). Rocker tip travel is
  amplified by the lever arm, so end-of-cap displacement ~0.4-0.6 mm — good tactile feel. Ensure the
  un-pressed dome is not back-driven by cap rock; the central pivot prevents this.
- **Travel:** correct to **0.20 mm** per real datasheet (same blocker as power).
- **Force balance:** datasheet volume force 1.5 N vs power 1.6 N is a marketing distinction; the SAME
  switch is 1.57 N (160 gf). Acceptable — drop the artificial 1.5/1.6 split, both are one switch.

**Margins/tolerances (mm):** same +/-0.11 register budget per dome; 21 mm cap length needs >=0.15 mm
slot clearance per side for thermal/mold bow. **Spacing/neighbor:** -X edge opposite power — no
cross-talk. Internally the two domes must clear the PCB-edge components by the 2.5 mm edge clearance.
**Occlusion:** long rocker may foul the SIM tray or a mid-frame screw boss on -X — verify the 21 mm
cap envelope vs `sim_tray.keepout` placement. **Open issues:** (1) define inter-switch pitch;
(2) travel 0.35->0.20; (3) collapse the 1.5/1.6 N split to single 1.57 N; (4) confirm -X rocker does
not overlap SIM tray keepout.

---

## 3. USB-C PORT

**As-drawn:** GCT USB4105-GF-A USB2 Type-C, 8.94 x 7.8 x 3.25 mm, on -Y bottom edge, insertion
keepout 12.5 x 10.5 x 5.0 mm, 20k cycles, aperture clearance 0.20 +/-0.10.

### Validation

- **Standardization:** GCT USB4105 is itself a widely-second-sourced commodity Type-C 2.0 mid-mount
  receptacle (LCSC C3020560 ~$0.548 @100k; JLCPCB stocked). Pin map is USB-IF fixed (verified against
  supplier pinout YAML). No change recommended; it is the right standard part. Korean-Hua / Jing
  Extension / XKB Type-C clones exist as cheaper alternates (~$0.20-0.35) if cost-down is needed, but
  GCT's reinforced shell + 20k cycles justifies it for a flagship edge.
- **Aperture clearance:** 0.20 +/-0.10 mm radial around the shell. Worst case 0.10 mm (tight) still
  clears; worst case 0.30 mm is cosmetically loose but functional. Plug-nose lead-in chamfer (0.3-0.5
  mm, 30-45 deg) on the molded aperture is required so a mis-aligned plug self-centers — **add to
  params**. PASS with chamfer.
- **Insertion keepout / plug travel:** 12.5 x 10.5 x 5.0 mm keepout vs an 8.94 x 7.8 x 3.25 mm body
  gives +1.78 mm X / +1.35 mm Y / +0.875 mm Z each side around the receptacle for the plug overmold
  shoulder and finger access. Standard USB-C plug overmold (~10-12 mm wide boot) needs the aperture
  face itself unobstructed; verify the bottom-edge wall return does not shadow the boot. PASS.
- **Retention / insertion force:** from supplier YAML — retention 8.0-20.0 N, insertion max 20 N,
  extraction min 8 N. Within USB-IF. The shell stake (-GF-A = 0.95 mm blank peg) provides PCB
  retention; on an 0.8 mm PCB use the through-hole shell pegs + heavy GND pad copper. PASS.
- **20k mate cycles:** matches spec; no derate.
- **IP54 (gaskets / drip-lip / drain-shelf):** the receptacle is **not sealed**. For IP54 on an
  open USB port the accepted approach is a drained, not sealed, port: (a) a **drip-lip** over the
  aperture top, (b) a **drain shelf / weep channel** at the bottom of the aperture so splash water
  runs out, (c) conformal coat on the PCB pads, (d) the connector's own potted back. A full gasket is
  not feasible on an open Type-C; document the drain-port strategy as the IP54 element — **add
  drip-lip + drain-shelf geometry to params** (currently missing).
- **Bottom-edge congestion (KEY):** -Y bottom edge shares with **speaker_bottom (15 x 11 x 3.5)** and
  **microphone_bottom (3.5 x 2.65 x 1.0)**. Across the 78 mm bottom width: USB-C ~8.94 mm centered,
  speaker offset to one side, bottom mic to the other. Layout budget: 8.94 (USB) + 15.0 (spkr) +
  3.5 (mic) = 27.4 mm of hard parts on a 78 mm edge — fits with ~50 mm to spare, BUT the USB
  insertion keepout (12.5 mm wide x 5.0 mm deep) must not overlap the speaker's rear acoustic chamber
  or the mic sound tunnel. **Action:** confirm >=1.0 mm wall between USB keepout and speaker box, and
  route the mic tunnel away from the USB drain shelf so water cannot wick into the mic port.

**Margins/tolerances (mm):** aperture radial 0.20 +/-0.10 (min 0.10 clear); shell-to-aperture
`usb_shell_to_aperture_clearance_mm: 0.15` consistent; Z profile 3.25 mm body in 11.8 mm depth — fits
with the bottom wall easily. **Occlusion/collision:** main risk is USB keepout vs speaker chamber and
mic tunnel on the crowded bottom edge — verify in CAD. **Open issues:** (1) add lead-in chamfer;
(2) add drip-lip + drain-shelf + weep channel for IP54; (3) verify USB keepout vs speaker chamber and
mic tunnel clearance.

---

## Blockers and required param edits

1. **Button travel data error (both buttons):** `travel_mm: 0.35` is wrong; real EVQ-P7 /
   TS-1187A / Alps SKRP datasheet travel is **0.20 mm**. Rebuild the cap travel stack; this is the
   one hard blocker.
2. **Button standard change (priority deliverable):** set `standardized_part: XKB TS-1187A-B-A-B`
   (LCSC C318884) as primary, Panasonic EVQ-P7A01P as alternate, for BOTH power and volume — one SKU.
3. **IP54 elements not specified:** add gasket/labyrinth callout for buttons; add drip-lip + drain
   shelf + weep channel for the USB aperture. The switches and the receptacle are unsealed parts.
4. **Volume rocker:** define inter-switch pitch; collapse the 1.5/1.6 N split to single 1.57 N.
5. **USB neighbor check:** confirm USB insertion keepout clears the speaker rear chamber and the
   bottom-mic sound tunnel on the -Y edge.

## Sources

- [XKB TS-1187A-B-A-B (LCSC C318884)](https://www.lcsc.com/product-detail/C318884.html)
- [XKB TS-1187A-B-A-B (JLCPCB)](https://jlcpcb.com/partdetail/XkbConnectivity-TS_1187A_B_AB/C318884)
- [Panasonic EVQ-P7A01P (LCSC C79167)](https://www.lcsc.com/product-detail/Tactile-Switches_PANASONIC-EVQP7A01P_C79167.html)
- [Panasonic EVQ-P7/P3/9P7 series (3.5x2.9 side-operational)](https://industry.panasonic.com/global/en/products/control/switch/light-touch/3529m_smd_side)
- [Panasonic EVQ-P7/P3/9P7 datasheet (Digi-Key)](https://www.digikey.com/htmldatasheets/production/1364703/0/0/1/evq-p7-p3-9p7-series.html)
- [Alps SKRPABE010 (LCSC C115360)](https://www.lcsc.com/product-detail/tactile%20switches_alpsalpine_skrpabe010_C115360.html)
- [Alps SKRPABE010 product page (top-push confirmation)](https://tech.alpsalpine.com/e/products/detail/SKRPABE010/)
- [C&K KMR2 series (top-actuated)](https://www.ckswitches.com/products/switches/product-details/Tactile/KMR2/)
- [C&K KMR221GLFS (LCSC C72443)](https://lcsc.com/product-detail/Tactile-Switches_C-K_KMR221GLFS_C-K-KMR221GLFS_C72443.html)
- [GCT USB4105-GF-A (LCSC C3020560)](https://www.lcsc.com/product-detail/usb-connectors_global-connector-technology-usb4105-gf-a_C3020560.html)
- [GCT USB4105 connector page](https://gct.co/connector/usb4105)
