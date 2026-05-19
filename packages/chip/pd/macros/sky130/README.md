# Sky130 hard SRAM macros (OpenRAM)

This directory is the destination for OpenRAM-generated SRAM macros that the
e1 floorplan, AlphaChip macro placement, DREAMPlace evaluation, and OpenROAD
detailed routing will all consume.

The macros listed in `pd/macros/manifest.yaml` are the **minimum** set needed
to make AlphaChip a real tool on e1. Until at least one of these macros lands
here with verified LVS-clean GDS, the OpenLane release reports
`Macros: 0`/`MacroArea: 0` (see
`research/alpha_chip_macro_placement/06_e1_notes/openlane_full_release_2026-05-19.md`)
and the AlphaChip protobuf reports zero hard macros after conversion
(`openlane_smoke_baseline_2026-05-19.md`). Both observations make macro
placement a no-op.

## What goes here

For each target macro `<name>` in the manifest:

```
pd/macros/sky130/<name>/
  <name>.lef                   placement abstract for OpenROAD
  <name>.gds                   final GDS for tapeout integration
  <name>.lib                   Liberty timing (typical + corners)
  <name>.spice                 SPICE netlist for LVS
  <name>.openram.config.py     OpenRAM input config (reproducibility)
  build/                       OpenRAM scratch (gitignored)
  README.md                    pin map, halo, dimensions, intended user
```

The manifest's `lef`/`gds`/`lib`/`spice` fields stay set to `BLOCKED_run_openram`
until those exact files exist.

## How to generate

OpenRAM is intentionally NOT vendored under `external/` because its outputs
are PDK-specific. The reproducible path is:

```sh
git clone https://github.com/VLSIDA/OpenRAM external/OpenRAM
cd external/OpenRAM
git rev-parse HEAD                                  # pin this in manifest.yaml
export OPENRAM_HOME=$PWD/compiler
export OPENRAM_TECH=$PWD/technology
make pdk PDK=sky130A
```

Then for each macro:

```sh
python3 $OPENRAM_HOME/openram.py \
    pd/macros/sky130/<name>/<name>.openram.config.py
```

Outputs land in the directory referenced by `output_path` in the config. Move
the `*.lef`, `*.gds`, `*.lib`, `*.sp` files into `pd/macros/sky130/<name>/`
and update `pd/macros/manifest.yaml` to point at them.

## Why these sizes

- **4 KB 32-bit:** small enough to instance many copies (8-16 per CPU L1
  cache slice). Realistic L1D-data-bank shape at 130 nm.
- **16 KB 32-bit:** NPU weight buffer scaffold. AlphaChip needs at least one
  macro this size to demonstrate macro-placement value on the e1 NPU floor.
- **64 KB 32-bit:** L2/L3 slice scaffold and NPU activation buffer. These are
  the macros where wirelength minimization actually pays.

At 130 nm a 64 KB SRAM is roughly 1.5 mm x 1.5 mm. Three of these alone push
total macro area past the 8 mm^2 mark, which is where AlphaChip-style RL
placement begins to outperform OpenROAD's analytical placer on proxy cost.

## DRC/LVS

Every macro must produce:

- `magic` Sky130 DRC clean on its standalone GDS.
- `netgen` LVS clean against its SPICE.
- `openroad` placement-density check clean inside the e1 floorplan.

Until those run, the macro stays in `BLOCKED_run_openram` state and the
`macro-placement-evidence.yaml` gate fails closed.
