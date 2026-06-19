# Sky130 hard SRAM macros (OpenRAM + PDK-prebuilt)

This directory is the destination for SRAM macros that the e1 floorplan,
AlphaChip macro placement, DREAMPlace evaluation, and OpenROAD detailed
routing all consume.

Two macro sources are accepted:

1. **PDK-prebuilt OpenRAM macros.** The Sky130 PDK Volare snapshot ships a
   `sky130_sram_macros` library with several pre-generated OpenRAM SRAMs
   (1 KB, 2 KB, and a 32x256 1RW1R block). The `sky130_sram_2kbyte_1rw1r_32x512_8`
   macro is currently wrapped by `rtl/memory/e1_weight_buffer_sram.sv` and
   instanced as `u_soc/u_weight_buffer/u_sram` in `e1_soc_top`. OpenLane reads
   its LEF/Liberty/GDS/Verilog through the `EXTRA_LEFS`, `EXTRA_LIBS`,
   `EXTRA_GDS_FILES`, and `EXTRA_VERILOG_MODELS` keys in
   `pd/openlane/config.sky130.json`. The `MACROS` block fixes the instance
   path so OpenLane treats it as a hard macro.

2. **Freshly generated OpenRAM macros.** Custom-sized SRAMs (4 KB, 16 KB,
   64 KB) listed under `pdks.sky130A.target_macros` in
   `pd/macros/manifest.yaml` are not in the PDK and are generated locally from
   the OpenRAM source tree (native build, see "How to generate" below).

## What goes here

For each target macro `<name>` in the manifest:

```
pd/macros/sky130/<name>/
  <name>.openram.config.py     OpenRAM input config (tracked source of record)
  build/                       OpenRAM outputs (the artifacts of record):
    <name>.gds                   final GDS for tapeout integration
    <name>.lef                   placement abstract for OpenROAD
    <name>_{TT,SS,FF}_1p8V_{25,85,-40}C.lib   Liberty timing corners
    <name>.sp                     SPICE netlist
    <name>.lvs.sp                 LVS-ready SPICE netlist
    <name>.v                      behavioral Verilog model
    <name>.html                   OpenRAM datasheet
```

The manifest's `lef`/`gds`/`lib`/`spice`/`verilog_model` fields point at the
exact files under `build/` once they exist, and stay `BLOCKED_run_openram`
until then.

## How to generate (native, Linux x64)

OpenRAM is checked out at `external/OpenRAM`
(commit `e16d9eb0b4495e8beee441ced3fcad68391155e6`, pinned in
`pd/macros/manifest.yaml` as `generator_pinned_commit`). The EDA stack it
shells out to (magic/ngspice/netgen/klayout) comes from the conda environment
at `~/.openram-miniconda`. Both are wired into the build driver
`build_openram_macro.sh`; no Docker.

Build one macro:

```sh
# Serialize heavy OpenRAM builds — only one at a time (the host OOM-thrashes
# if two run concurrently).
flock -w 21600 /tmp/eliza_heavy_eda.lock -c \
  'pd/macros/sky130/build_openram_macro.sh pd/macros/sky130/e1_sram_4kb_1rw'
```

The driver copies `<name>.openram.config.py` to `build/openram_config.py`
(OpenRAM rejects dotted config basenames) and runs
`external/OpenRAM/sram_compiler.py`. Outputs land directly under
`pd/macros/sky130/<name>/build/`: `<name>.{gds,lef,sp,v}`, the Liberty corner
libs (`<name>_{TT,SS,FF}_1p8V_{25,85,-40}C.lib`), the LVS netlist
(`<name>.lvs.sp`), and a datasheet (`<name>.html`). Point the manifest's
`lef`/`gds`/`lib`/`spice`/`verilog_model` fields at those exact files.

Build time is dominated by the bitcell-array submodule generation and routing;
the 4 KB macro took ~6.9 h wall on this host (1024w x 32b, 512 cols x 64 rows).
The 16 KB (256 rows) and 64 KB (1024 rows) macros scale accordingly and are the
long poles of the inventory.

## DRC verification (native)

Inline DRC is disabled in the configs because the openram-miniconda Magic
(8.3.363) cannot load Volare's sky130A techfile (needs 8.3.411+). Verify
afterwards with the native Magic on PATH (`tools/env.sh` → magic 8.3.645):

```sh
source tools/env.sh
python3 scripts/check_openram_macro_drc.py \
    --macro-dir pd/macros/sky130/e1_sram_4kb_1rw/build \
    --macro-name e1_sram_4kb_1rw \
    --out-json build/reports/pd/openram_4kb_drc.json
```

The script runs `drc count` (per-cell attribution, the same signal OpenRAM's
own `compiler/verify/magic.py` uses) and classifies error tiles by cell:
`bitcell_waived` (the proprietary SkyWater `sky130_fd_bd_sram__*` foundry
bitcells, which are not DRC-clean under the open `drc(full)` ruleset by
construction and are waived in the closed PDK flow) vs `periphery` (the
OpenRAM-generated decoders/drivers/control/wiring). PASS == zero periphery
error tiles. Tapeout-grade signoff remains the OpenLane flow that carries the
macro as an abstracted hard block (see `pd/openlane/runs/.../63-magic-drc/`).

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

## Signoff checklist

Each macro must produce:

- `magic` periphery DRC clean on its standalone GDS (see
  "DRC verification" above; foundry-bitcell pseudo-errors are waived).
- `netgen` LVS clean: extracted-from-GDS netlist vs `<name>.lvs.sp`, using
  `external/pdks/.../sky130A/libs.tech/netgen/sky130A_setup.tcl`.
- `openroad` placement-density check clean inside the e1 floorplan, carried
  through the OpenLane flow as an abstracted hard macro.

A macro's manifest entry stays `BLOCKED_run_openram` until the LEF/GDS/Liberty/
SPICE files exist; the `drc` field records the periphery-DRC verdict and
report path once `scripts/check_openram_macro_drc.py` has run.
