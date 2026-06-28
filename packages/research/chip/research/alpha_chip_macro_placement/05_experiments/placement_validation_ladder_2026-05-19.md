# Placement Validation Ladder - 2026-05-19

AlphaChip/Circuit Training proxy cost is a fast optimization signal, not
physical-signoff evidence. Promising E1 placements should move through this
ladder before claims are made.

## 1. Structural validation

- Parse the CT `.plc` and generated netlist.
- Convert macro coordinates back into DEF/OpenDB representation.
- Load LEF/DEF in OpenROAD/OpenDB.
- Check macro count, fixed/placed status, orientation, die bounds, overlap, and
  blockage consistency.

References:

- OpenROAD docs: <https://openroad.readthedocs.io/en/latest/main/src/README.html>
- OpenDB docs: <https://openroad.readthedocs.io/en/latest/main/src/odb/README.html>

## 2. Fast proxy scoring

Track the CT proxy metrics for every candidate:

- `ct_proxy_total`
- `ct_wirelength_cost`
- `ct_congestion_cost`
- `ct_density_cost`
- `ct_wirelength`

For E1, add custom locality metrics for NPU, CPU/AP, SRAM, display, interrupt,
and external-interface clusters once subsystem tags are available in the
soft-macro generator.

## 3. OpenROAD placement validation

Run the same downstream placement stage for baseline and candidate placements:

- legalize or fix macro placement as required.
- place standard cells around the candidate macro locations.
- run `check_placement`.
- capture HPWL, macro displacement, density, and violation counts.

OpenROAD Hier-RTLMP should be added as a native macro-placement baseline:
<https://openroad.readthedocs.io/en/latest/main/src/mpl/README.html>.

## 4. Routability proxy

Run global routing and capture:

- total overflow.
- max overflow.
- overflow iterations.
- congested GCell count.
- guide generation success.
- congestion heatmaps or reports.

Global-routing metrics are the first serious filter for proxy-cost wins because
CT proxy improvements can disappear after real routing.

## 5. Timing and power proxy

Use OpenSTA through OpenROAD:

- `estimate_parasitics -placement` for a quick placement-level signal.
- `estimate_parasitics -global_routing` after global route for a stronger
  signal.

Capture WNS, TNS, violation counts, worst path delay, max slew/fanout/cap
violations, and estimated power where available.

Reference:
<https://openroad.readthedocs.io/en/latest/main/src/est/README.html>.

## 6. Full-flow gate

For publishable claims, continue through OpenLane/OpenROAD detailed route and
compare the resulting `metrics.json` or equivalent run metrics across:

- baseline OpenROAD/OpenLane.
- AlphaChip placement.
- AlphaChip plus coordinate-descent finisher.
- OpenROAD Hier-RTLMP.
- DREAMPlace, Xplace, or AutoDMP when available.

KLayout and Magic/Netgen provide independent geometry checks where the PDK rule
decks support them:

- KLayout DRC: <https://www.klayout.org/downloads/master/doc-qt5/manual/drc_basic.html>
- Magic docs: <https://magicvlsi.wordpress.com/documentation/>

## Minimum comparison table

Each placement result should include CT proxy terms, OpenROAD HPWL,
global-route overflow, congested GCell count, WNS, TNS, setup/hold violation
counts, DRC and antenna violation counts, macro legality counts, runtime, and
GPU hours where applicable.

## Caveats

- A CT proxy win is not a routed PPA win.
- A routed PPA win is not foundry signoff.
- KLayout/Magic DRC quality depends on available PDK rule decks.
- Improvements should be reported as reproducible flow results, not as a broad
  claim that AlphaChip is generally superior.
