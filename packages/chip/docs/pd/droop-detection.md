# Droop detection + clock stretcher contract

Status: `planning_evidence_release_blocked`

## Scope

This document is the contract between the RTL (`rtl/power/droop_sensor.sv`
and `rtl/power/clock_stretcher.sv`) and the cocotb harness
(`verify/cocotb/power/test_droop_event.py`). It records the algorithmic
behavior, latency contract, and calibration boundary.

## Components

### Ring-oscillator droop sensor

A free-running ring oscillator on the monitored rail clocks an asynchronous
counter. At every sample period (5 ns @ `DROOP_SAMPLE_HZ` = 200 MHz), the
counter is captured and reset.

A captured count below `threshold_i` for `DROOP_CONFIRM_SAMPLES` consecutive
samples raises `droop_alarm_o` for one sample period.

Ports:

- `clk_sample` — 200 MHz reference (shared across all rails).
- `ro_clk_i` — ring-oscillator output on the monitored rail.
- `sample_tick_i` — 1-cycle pulse per sample window.
- `threshold_i` — `DROOP_COUNTER_WIDTH`-bit absolute RO-cycles-per-sample
  threshold. Programmed by AVFS / PMC firmware after silicon characterization.
- `droop_alarm_o` — 1-cycle pulse, sample-period aligned.
- `droop_event_count_o` — 32-bit telemetry counter.

### Clock stretcher

Per CPU big core and per NPU tile. Behavioral model of a phase-blender stretch:
on `droop_alarm_i` rising edge, output `clk_o` is held low for one input clock
period and `stretch_o` pulses high for the same duration.

Ports:

- `clk_in_i` — functional clock.
- `droop_alarm_i` — sample-aligned alarm from sensor.
- `phase_select_i` — `CLKSTRETCH_SELECT_WIDTH`-bit phase tap select.
  Currently unused in behavioral model.
- `clk_o` — stretched output clock.
- `stretch_o` / `stretch_event_count_o` — telemetry.

## Latency contract

```
RO droop -> sensor capture        : 1 sample period (5 ns @ 200 MHz)
sensor capture -> alarm           : DROOP_CONFIRM_SAMPLES samples (default 2)
alarm -> stretcher response       : 1 clk_in_i cycle
total worst case                  : ~15 ns @ 200 MHz sample + ~4 ns @ 250 MHz core
```

This matches the 22 nm ADCD reference (Bowman/Tokunaga, ISSCC 2015) and the
AMD/IBM ACS published numbers (single-cycle stretch).

## Calibration

`threshold_i` must be set by AVFS / PMC firmware after silicon
characterization. The RO frequency-vs-Vdd curve is silicon-corner-specific:

- TT  : ~RO count per sample = K_TT  - alpha * (V_nom - V).
- SS  : K_SS  shifts lower; AVFS raises voltage to compensate.
- FF  : K_FF  shifts higher; AVFS lowers voltage to harvest headroom.

`DROOP_DEFAULT_THRESHOLD` (16'd2048) is a **planning-only** placeholder. It
is replaced at silicon bring-up by per-corner values written through the PMC
mailbox to per-rail threshold registers (not yet exposed; tracked in
`docs/evidence/power/droop-sensor-evidence.yaml`).

## Verification

- Cocotb: `verify/cocotb/power/test_droop_event.py` — 3/3 tests pass against
  `droop_stretch_tb`.
- Make target: `make cocotb-droop`.

## Release blockers

- Silicon characterization data not available; threshold values are
  placeholder.
- RO cell library not selected (foundry-dependent).
- Phase-blender mux behavioral model only; real implementation requires
  analog mux + interpolator post route.
- Sensor placement plan not committed to `pd/openroad/` floorplan.

## References

- Bowman/Tokunaga, ISSCC 2015 — "A 22 nm All-Digital Dynamically Adaptive
  Clock, Voltage, and Power Management for Mobile Microprocessor"
- POWER9 adaptive clocking, ISSCC 2017
- Apple droop-detector patents: USPTO 10145868, 10320375, 10749513, 11397444
