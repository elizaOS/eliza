# E1 Phone Mainboard — Schematic-Capture Work Breakdown

Status: **NON-RELEASE — concept scaffold.** This document defines the concrete
professional-EDA work that must complete before the E1 phone mainboard can be
routed. It does not claim any of that work is done. It pairs with the library
match prepared in
[`board/kicad/e1-phone/footprint-3d-model-library-map.yaml`](../../../board/kicad/e1-phone/footprint-3d-model-library-map.yaml).

## Where the board actually stands

- `board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb` contains **87
  `E1Phone:` placeholder footprints**. Each is tagged `E1_PHONE_PLACEHOLDER`
  / `NON_RELEASE` and carries only generic, evenly-pitched pad rows (for example
  `J_USB_C` has 6 pads at ~2.28 mm pitch, not the real GCT USB4105 16-position
  land pattern). They are placement anchors, not manufacturer land patterns.
- The board has **no pin-level electrical netlist**. A prior investigation
  recorded **1316 DRC** and **366 ERC** violations — consistent with a concept
  scaffold, not a routable design.
- A real schematic exists only as scaffold fragments under
  `board/kicad/e1-phone/schematic/` plus a partial symbol library
  (`e1_phone_symbols.kicad_sym`). There is no complete, ERC-clean schematic.

A full routed release requires professional schematic capture first. That work
is correctly **blocked** and is not faked here.

## The residual work, in order

Routing is the **last** step, gated on every step before it.

### 1. Freeze supplier inputs (hard upstream blocker)

Owned by the existing supplier-evidence gates
(`board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml`,
`supplier-drawing-intake-checklist.yaml`,
`evt1-footprint-capture-work-package.yaml`). For every IC, module, SoC, memory,
connector, and tray: a signed 2D drawing, pinout/pad map, recommended land
pattern, and STEP model. Until these arrive, all IC/module/SoC land patterns
stay `needs_custom_or_supplier_step` (see the library map).

### 2. Real schematic symbols

Build a complete symbol for every device with correct pin numbers, names,
electrical types (input/output/power/passive/bidirectional), and units. The
SoC, LPDDR, eMMC, PMIC, PD controller, charger, codec, Wi-Fi/BT module, and
cellular modem each need a pin-accurate symbol from its datasheet — the current
`e1_phone_symbols.kicad_sym` is a partial scaffold (SoC BGA256, LPDDR5X,
DA9063, TPS65987, MAX77860, USB_C_24p, battery connector). Symbols must match
the frozen MPNs from step 1, not placeholders.

### 3. Pin-level schematic and ERC

Draw the full schematic across the sheet set
(`compute`, `power_usb`, `display_camera`, `radios`, `audio_buttons`,
`split_interconnect`): connect every net, place every passive (decoupling,
ESD, pull-ups, damping, RF matching) with real values and refdes, define power
rails and net classes, and add power-flag/no-connect annotations. Run **ERC to
zero unexplained violations**. This is what produces the electrical netlist the
concept PCB does not have.

### 4. Footprint assignment (this is where the library map is consumed)

Assign a footprint to every symbol. Use
`footprint-3d-model-library-map.yaml` as the vetted starting point:

- **matched** — bind directly: GCT USB4105 USB-C receptacle (line 17), the
  40-pin 0.5 mm FPC mating connector for the display tail (line 12, Hirose
  FH12-40S candidate), standard 0402/0201 R/C passives, the flash-LED 0603
  candidate land (line 15a).
- **matched_footprint_only** — bind the land pattern, then source the missing
  3D body: Panasonic EVQP7A tactile switch (line 18, `SW_SPST_EVQP7A`) and
  Knowles SPK0641HT4H-1 MEMS mic (line 19, `Knowles_LGA-5_3.5x2.65mm`). Their
  footprints reference a `.wrl` that is absent from the local `.3dshapes`
  subset; pull it from the full `kicad-packages3d` release or the supplier STEP.
- **needs_custom_or_supplier_step** — author a custom land pattern from the
  supplier drawing (step 1): SoC/LPDDR/eMMC BGAs, SC2730 PMIC, BQ25895 charger,
  TPS65987 PD, ALC5640 codec, AW36515 fine-pitch FCQFN-10 driver, DRV2605L,
  Murata Type 2EA and Quectel RG255C modules, the nano-SIM tray, and the
  board-to-board / FPC interconnects whose MPN is still unfrozen.

Replace the 87 `E1Phone:` placeholders one-for-one as their symbols get
real footprints. Verify the active KiCad install: the deb-tools 9.0.9 binary
ships **no 3D models**, so 3D fit checks must run against the
`.tools/kicad-local` model subset (or the full `kicad-packages3d` package).

### 5. Netlist import and footprint association

Import the ERC-clean netlist into the PCB, associate each refdes with its
assigned footprint, and confirm the ratsnest reflects the real netlist — not
the placeholder groups.

### 6. Constraint setup and DRC

Apply net classes, controlled-impedance and differential-pair rules (the
existing `routing-constraints.yaml` lists 24 diff pairs to preserve),
clearances, and mechanical keepouts. Run **DRC to zero** on the unrouted board
before routing begins — this is what retires the recorded 1316 DRC violations
at the source rather than masking them.

### 7. Route

Only now is routing meaningful: place per the placement matrix, route power /
RF / high-speed / general nets within the constraints, pour planes, re-run DRC
to zero, and run signal-integrity checks against the USB / MIPI / LPDDR / RF
budgets already drafted in the board YAML set.

## Definition of "routable"

The board becomes routable when steps 1–6 are complete: frozen supplier inputs,
pin-accurate symbols, an ERC-clean pin-level schematic (real netlist), every
symbol bound to a real or supplier footprint, the netlist imported with
associations, and DRC clean on the unrouted board. Until then the concept PCB
stays a scaffold and no release or routed gate may be flipped.
