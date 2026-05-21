# E1 Phone Engineering Validation Plan

Status: CAD validation inputs ready; physical EVT validation still required.

## CAD-Derived Tolerance Cases

- PASS: `screen_xy_fit` = 0.45 (Minimum CTP-to-orange-body margin in X/Y.)
- PASS: `pcb_edge_clearance` = 7.0 (Minimum board edge clearance to outer molded envelope.)
- PASS: `usb_shell_to_aperture` = 0.175 (Minimum modeled shell clearance to external USB-C aperture.)
- PASS: `battery_to_pcb` = 1.0 (Minimum gap from pouch battery to rigid PCB islands.)
- PASS: `button_pressure` = 0.119 (Nominal side-key force divided by cap contact area.)

## Domain Reviews

- `thermal`: inputs_present; next: Run thermal simulation after routed board power map and enclosure resin are locked.
- `rf`: inputs_present; next: Export antenna keepouts into PCB/RF tool and run desense/SAR pre-scan.
- `acoustic`: inputs_present; next: Measure loudspeaker, mic, and earpiece leakage with molded sample and gasket stack.
- `drop`: inputs_present; next: Run FEA/drop pre-check, then corner/face/edge drop on soft-tool samples.
- `ingress`: design_intent_only; next: Add real port membranes/gaskets and run dust/splash tests after supplier stack lock.

## Assembly Sequence

1. Mold orange back shell and side frame; inspect gate, ejector, sink, and color consistency.
2. Install USB-C receptacle, bottom speaker, microphones, earpiece gasket, haptic, and cameras onto PCB/subassemblies.
3. Place battery into ribbed window and connect board/display FPC using the KiCad mechanical handoff constraints.
4. Bond screen cover glass/display stack with die-cut adhesive and verify FPC bend radius.
5. Install orange power and volume caps, close snap hooks/screws, then inspect button force, USB insertion, audio ports, and camera windows.

## DVT Plan

- `USB-C insertion/removal`: n=5; 20k-cycle candidate port; no shell shift or aperture rub.
- `Side key force/travel`: n=10; 1.2-2.2 N actuation and no cap sticking after tolerance extremes.
- `Display bond and FPC bend`: n=5; No lift, no glass clash, bend radius >= 1.0 mm.
- `RF pre-scan/desense`: n=3; Antenna keepouts respected with cellular and Wi-Fi active.
- `Acoustic leakage`: n=5; Speaker, earpiece, and mic paths pass OEM acoustic targets.
- `Soft-tool DFM review`: n=1; Toolmaker signs off draft, gates, ejectors, cooling, sink, and parting line.
