# PCB Tooling, Signal Integrity, Power Integrity

Date: 2026-05-19

## KiCad 9 / open PCB toolchain

- **KiCad 9** (Feb 2024) brings hierarchical schematic improvements,
  IPC-2581 export, full ngspice integration, improved length-tuning UI,
  better differential-pair handling. KiCad 9 is the realistic open
  toolchain for an E1 phone board.
- **FreeCAD STEP integration** — round-trip PCB shape between KiCad and
  FreeCAD for mechanical co-design (phone enclosure cutouts, FFC connector
  alignment).
- **`kibot` / `kicad-cli`** — CI-friendly KiCad command-line for automated
  Gerber + IPC-2581 + BOM + 3D STEP generation. Already used by
  PinePhone, MNT Reform, Tropical Labs, etc.
- **`InteractiveHtmlBom`** — generates clickable BOM-to-board map for
  hand-assembly. Important for small-batch open-phone work.

## PCB fabrication transfer

- **IPC-2581 Rev C** (2023) — vendor-neutral PCB fab transfer format. Both
  layout (RS-274X equivalent) and assembly (Pick&Place, BOM) live in one
  IPC-2581 file. Modern phone fabs (PCBWay, JLCPCB, MacroFab) all accept
  IPC-2581.
- **Gerber RS-274X + Excellon** — legacy fallback. Still required for some
  fabs, but IPC-2581 is the modern target.

## Footprint standards

- **IPC-7351B Generic Requirements for SMD Land Patterns** — defines
  density level A/B/C (most/nominal/least) for footprint generation.
  KiCad's footprint library mostly follows IPC-7351 density level B.
- **IPC-A-610 Acceptability of Electronic Assemblies** — final visual
  acceptance reference for assembled boards.

## Signal integrity for phone-class boards

### LPDDR5X (8533 Mbps/pin)

LPDDR5X is the dominant SI/PI constraint on a phone-class AP board.

- **8533 Mbps/pin** data rate (DDR5 effective).
- **WCK** (write clock) is forwarded at 4x DQS rate, requires tight phase
  alignment to DQ.
- **VDD2 = 1.05 V**, **VDDQ = 0.5 V** — VDDQ is the new low-voltage IO
  rail (LPDDR5X-specific) that requires its own LDO.
- **Routing rules**:
  - DQ to DQS skew: < 5 ps within byte lane.
  - DQ trace length: ~10-20 mm typical for in-package or
    PoP-on-board flyby.
  - Differential 80 ohm for CK/WCK.
  - Power-aware routing — every DQ via must have a nearby ground
    return via.
  - On-die ZQ calibration termination — board does not need DDR
    termination resistors but reference clock matching is strict.
- **Breakout vias** — micro-via or laser-drilled via-in-pad is required
  for BGA pitch < 0.5 mm. Phone-class BGAs are 0.35-0.4 mm pitch.

### MIPI DSI / CSI

- **100 ohm differential**, length-matched within lane (<2 mm) and across
  lanes (<10 mm).
- **HS-TX common-mode ~200 mV**, **LP-TX 0-1.2 V** — pad cells must
  support both modes (covered in `display_dsi_dsc.md`).
- **Edge-coupled microstrip** typical, stripline OK with via stitching.

### USB 3.x / USB4

- **90 ohm differential**, AC-coupled with 100 nF caps.
- **Insertion loss budget**: ~-6 dB at 5 GHz for USB 3.2 Gen 2 (10 Gbps).
- **USB-PD CC lines**: not high-speed, standard 50 ohm.

## Power integrity (PDN)

### Target impedance for phone AP

For an E1-class SoC pulling up to 14 A on `VDD_CPU_NPU` (per the v0 SoC
operating point), the PDN target impedance is roughly:

```
Z_target = (V_rail * ripple_tolerance) / I_peak
        = (0.9 V * 0.03) / 14 A
        ~= 1.9 mohm
```

That impedance must hold from DC up to the on-die clock domain (1 GHz for
NPU clock). Achievable via:

- Multi-phase buck converter (3-4 phases for >10 A).
- 22-100 uF bulk MLCCs at the buck output (typically 4-6 caps).
- 1-10 uF MLCCs distributed at every cluster of BGA power vias.
- 100 nF + 10 nF decoupling at every power ball pair on the BGA, typically
  via cap-in-via or back-side-of-board placement.
- Embedded capacitance (Faradflex / Oak-Mitsui power planes) is overkill
  for phone boards.

### PDN simulation tools

- **`KiCad PDN Analyzer`** (community plugin) — DC resistance and basic
  AC impedance.
- **`OpenEMS`** — full-wave EM solver, open source. Slow but free.
- **Cadence Sigrity / Ansys SIwave** — closed industry tools.
- **IBIS / IBIS-AMI** — behavioral driver/receiver models for SI sim.
  Open spec, models supplied by silicon vendors.

## PoP vs side-by-side LPDDR5X

Phone-class AP-LPDDR co-package options:

1. **PoP (Package-on-Package)** — LPDDR5X stacked on top of AP package via
   solder balls around the periphery. Saves board area but constrains
   thermal (LPDDR sits on top of hot AP).
2. **Side-by-side LPDDR5X discrete** — LPDDR5X package next to AP on the
   board with flyby routing. Better thermal isolation, larger area.
3. **Co-packaged via interposer** — too expensive for phone, only seen on
   server-class.

For E1 v0, side-by-side LPDDR5X discrete is the realistic open-build
choice. PoP requires LPDDR5X-PoP-aware package design at tape-out.

## Gaps for E1

| Gap | Required artifact | Status |
| --- | --- | --- |
| KiCad mainboard schematic | `board/kicad/e1-phone/` | Empty |
| LPDDR5X co-design with E1 package | `package/lpddr5x/<part>.yaml` | Missing |
| PDN target impedance per rail | `docs/board/pdn-budget.md` | Missing |
| IBIS model for E1 IOs | `package/ibis/e1.ibis` | Missing |
| Reference fab transfer | IPC-2581 export config | Missing |
| Footprint library | KiCad libs validated against IPC-7351 | Missing |

## High-confidence recommendations

1. **Commit to KiCad 9 + IPC-2581** for all E1 board work. Establish
   `kibot` CI for Gerber + IPC-2581 + BOM + STEP generation.
2. **Author `docs/board/pdn-budget.md`** with target impedance per rail
   before any layout work. The numbers above are starting points; final
   numbers depend on the v0 SoC operating point in
   `docs/architecture-optimization/soc-optimized-operating-point.yaml`.
3. **Side-by-side LPDDR5X discrete** for v0. PoP is out of scope.
4. **Author E1 IBIS model** when the padframe stabilizes. Without IBIS,
   SI simulation is impossible.
5. **Use FreeCAD for enclosure co-design** with KiCad STEP export.
