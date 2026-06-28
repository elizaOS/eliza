# E1 Demo — KiCad 7 Project

Evaluation board for the e1 chip SoC (`e1_chip_top.sv`).
Board spec: `docs/board/kicad/e1-demo/fab-notes.md`

> **Not for fabrication.** ERC and DRC must pass with 0 errors, footprints must be derived from the package vendor drawing, and all acceptance criteria in `docs/manufacturing/physical-closure-work-order.yaml` must be satisfied before release.

---

## Files

| File | Purpose |
|---|---|
| `e1-demo.kicad_pro` | KiCad 7 project file — links schematic and PCB, sets design rules, net classes |
| `e1-demo.kicad_sch` | Root schematic (Sheet 1) — hierarchical sheet instantiating the four sub-sheets |
| `power.kicad_sch` | Sheet 2 — Power: TPS62150RGTR (VDDCORE 0.8V/3A), TLV74033 (VDD\_3V3), TLV74018 (VDD\_1V8) |
| `osc_reset.kicad_sch` | Sheet 3 — Oscillator (SiT8924B 24MHz) and reset supervisor (MAX823LEUR+T) |
| `debug_io.kicad_sch` | Sheet 4 — Debug header J1, UART J2, USB-C J3, test points TP1–TP8 |
| `e1-demo.kicad_pcb` | PCB layout — 100×80mm 4-layer, board outline, stackup, mounting holes, example placements |
| `bom.csv` | Bill of materials — all components with MPN, footprint, description |

---

## Tools Required

- KiCad 7.0 or later (https://www.kicad.org/download/)
- KiCad standard symbol and footprint libraries (installed with KiCad)

---

## Opening the Project

```sh
kicad e1-demo.kicad_pro
```

This opens the KiCad project manager. From there:

- Click **Schematic Editor** to open `e1-demo.kicad_sch` (root sheet)
- Click **PCB Editor** to open `e1-demo.kicad_pcb`

---

## Running ERC (Electrical Rules Check)

1. Open the Schematic Editor.
2. Navigate to **Inspect → Electrical Rules Checker**.
3. Click **Run ERC**.
4. Resolve all errors before proceeding to PCB layout.

Known items to fix before ERC passes cleanly:

- Sub-sheet files (`soc.kicad_sch`) referenced in the root sheet do not exist yet — the SoC sheet must be created with all `e1_chip_top.sv` ports placed and connected.
- Power flags (`PWR_FLAG`) should be added to each supply rail to suppress "pin not driven" warnings on power nets.
- No-connect markers must be placed on all genuinely unconnected pins.

---

## Assigning Footprints

1. Open the Schematic Editor.
2. Go to **Tools → Assign Footprints**.
3. Verify that every component has a footprint assigned matching the BOM MPN.
4. The SoC (`U1 e1_chip_v0`) footprint must be regenerated from the package vendor drawing — the placeholder QFN64 is not release-quality.

---

## PCB Layout Checklist

- [ ] Import netlist from schematic (Schematic Editor → **File → Export → Netlist**; PCB Editor → **File → Import → Netlist**)
- [ ] Place all components within the 100×80mm outline
- [ ] Verify SoC decoupling caps (100nF + 10nF pairs) are within 0.5mm / 1.5mm of each VDD pad
- [ ] Route CLK\_24M as 50Ω controlled-impedance trace (≈0.36mm wide on L1 over L2 GND at 0.2mm dielectric)
- [ ] Route power rails on L3 PWR plane (split: VDDCORE / VDD\_3V3 / VDD\_1V8 regions)
- [ ] Pour GND solid copper on L2
- [ ] Add stitching vias around the board perimeter and between power islands
- [ ] Verify USB-C J3 VBUS trace width supports 0.5A continuous (≥0.5mm on L1 1oz copper)
- [ ] Place mounting holes MH1–MH4 at corners (already in PCB file at 3.5mm from each edge)

---

## Running DRC (Design Rules Check)

1. Open the PCB Editor.
2. Go to **Inspect → Design Rules Checker**.
3. Click **Run DRC**.
4. Resolve all errors. The project design rules enforce:
   - Min track width: 0.127mm (5 mil)
   - Min clearance: 0.127mm
   - Min via drill: 0.3mm / annular ring: 0.1mm
   - Min copper-to-edge: 0.5mm

---

## Exporting Gerbers for Fabrication

1. Open the PCB Editor.
2. Go to **File → Fabrication Outputs → Gerbers**.
3. Select output directory `gerbers/`.
4. Enable layers: F.Cu, In1.Cu, In2.Cu, B.Cu, F.Mask, B.Mask, F.SilkS, B.SilkS, F.Paste, B.Paste, Edge.Cuts.
5. Check **Use Protel/Altium filename extensions** for most fab houses.
6. Generate drill file: **File → Fabrication Outputs → Drill Files** (Excellon format, PTH + NPTH separate).
7. Submit the complete `gerbers/` directory for DFM review before ordering.

Stack-up for fab order:
- L1 F.Cu — 1 oz (35µm) signal
- Prepreg — 0.2mm Isola 370HR (or equivalent)
- L2 In1.Cu — 0.5 oz (17.5µm) GND
- Core — 0.6mm FR4
- L3 In2.Cu — 0.5 oz (17.5µm) PWR
- Prepreg — 0.2mm Isola 370HR
- L4 B.Cu — 1 oz (35µm) signal
- Surface finish: ENIG (2–6µin Au / 120–240µin Ni)
- Solder mask: LPI green both sides
- Silkscreen: white LPI both sides

---

## Next Steps (Fabrication Blockers)

1. **SoC footprint**: Obtain package vendor drawing for the e1 chip QFN64 package. Regenerate `U1` footprint from vendor data. The placeholder `QFN-64-1EP_9x9mm_P0.5mm_EP6.5x6.5mm` is not release-quality.
2. **SoC schematic sheet**: Create `soc.kicad_sch` with all `e1_chip_top.sv` ports (CLK\_IN, RST\_N, DBG\_\*, JTAG\_\*, TEST\_MODE, IRQ\_\*, GPIO\[7:0\]) placed, connected to global net labels, and no-connected where appropriate.
3. **ERC clean**: Resolve all ERC errors (power flags, undriven pins, missing no-connects).
4. **PCB routing**: Complete trace routing, power plane pours, via stitching.
5. **DRC clean**: Resolve all DRC errors.
6. **SI/PI analysis**: Verify decoupling, PDN impedance, 50Ω trace impedance for CLK\_24M.
7. **DFM review**: Submit Gerbers to assembly house for DFM check before ordering.
8. **Sign-off**: Close all items in `docs/manufacturing/physical-closure-work-order.yaml`.
