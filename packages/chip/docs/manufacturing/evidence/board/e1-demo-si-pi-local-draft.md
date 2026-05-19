# E1 Demo SI/PI Local Draft Review

Status: draft local review, not SI/PI signoff
Board revision: `r0-nonrelease`
Review date: 2026-05-18
Reviewer: local SI/PI preflight
Disposition: blocked for fabrication release

## Scope

This review captures local SI/PI readiness notes for the planning board. It is
not a field-solver result, PDN impedance report, stackup approval, or lab
measurement.

Reviewed local inputs:

- `board/kicad/e1-demo/e1-demo.kicad_pcb`
- `board/kicad/e1-demo/power.kicad_sch`
- `board/kicad/e1-demo/osc_reset.kicad_sch`
- `board/kicad/e1-demo/debug_io.kicad_sch`
- `board/reports/fab/e1-demo-2026-05-17/e1-demo-drc-report.txt`
- `docs/board/kicad/e1-demo/fab-notes.md`

## Local Readiness Notes

- The planning board separates the explicit 1.8 V and 3.3 V bring-up rails in
  the documentation and current-limit notes.
- Debug, GPIO, IRQ, JTAG, clock, and reset nets are low-speed planning nets.
- The clock net is called out for controlled routing review before release.
- Decoupling and sequencing remain preliminary and must be replaced by a
  package-aware PDN plan.

## Release Blockers

- No vendor stackup is selected or archived.
- No impedance coupon, trace-geometry calculation, or field-solver report is
  archived for the clock or debug paths.
- No PDN impedance target, rail load model, capacitor anti-resonance review, or
  plane-return-path review is archived.
- No package parasitic model, IBIS model, S-parameter data, or padframe IO model
  is available.
- No lab measurement or first-article waveform capture is archived.

## Required Release Evidence

- Board vendor stackup with dielectric data, copper weights, and impedance
  tolerance.
- SI review for clock, reset, debug, JTAG, IRQ, and GPIO routes after final
  placement.
- PI review for 1.8 V core and 3.3 V IO rails using a documented load model.
- Package/padframe IO model or accepted waiver for every board-facing signal.
- First-article rail ripple, clock quality, reset, and debug-link captures.
