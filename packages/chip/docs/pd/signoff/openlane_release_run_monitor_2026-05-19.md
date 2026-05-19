# OpenLane Release Run Monitor: 2026-05-19

## Active Run

- run directory: `pd/openlane/runs/RUN_2026-05-19_01-52-14`
- launcher lock: `.openlane-run.lock`
- launcher pid: `64327`
- docker container: `c9481c546626`
- config: `pd/openlane/config.sky130.json`
- image: `ghcr.io/efabless/openlane2:2.4.0.dev1`
- started_at: `2026-05-19T01:52:01Z`

The run is active and must not be killed or restarted. At the time of this
monitoring pass, the latest discovered step was
`36-openroad-resizertimingpostcts`; KLayout DRC had not started yet.

## KLayout DRC Watch Criteria

When the run reaches `*-klayout-drc`, treat the step as complete only if all of
these are present in the same step directory:

- `state_out.json`
- `runtime.txt`
- `reports/drc_violations.klayout.xml`
- converted JSON or signoff KLayout report, when OpenLane emits it

If a `*-klayout-drc` directory exists without `state_out.json`, keep the run
blocked and collect `COMMANDS`, `config.json`, `*.process_stats.json`,
`*.log`, and the `reports/` directory contents. The previous incomplete run
`RUN_2026-05-18_04-00-56` stopped inside KLayout DRC without a report, so a
missing XML report must not be interpreted as clean DRC.

## Antenna Metadata And Padframe Blockers

The latest completed full run reported missing top-level antenna metadata on:

- input gate metadata: `JTAG_TCK`, `JTAG_TDI`, `JTAG_TMS`, `TEST_MODE`
- output diffusion metadata: `DBG_READY`, `JTAG_TDO`

Release cannot be unblocked by hand-editing LEF antenna properties. Required
real integration work is:

- select a foundry IO library with input, output, bidirectional, power, ground,
  ESD, corner, and filler pad cells
- instantiate those pad cells around the release top
- connect the JTAG/test/debug pins to real IO pads and tested internal logic, or
  remove scaffold-only pins from the release top
- archive padframe-inclusive DRC, LVS, antenna, and ESD evidence from one
  selected run

## Current Release Blockers

KLayout DRC was clean in `RUN_2026-05-18_05-41-42`, but the release gate remains
blocked by antenna violations, top-level antenna metadata warnings, hold/max
slew/max capacitance violations, open antenna/STA waivers, and missing
padframe/package/SI/PI/PDN-current release evidence.
