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
   `pd/macros/manifest.yaml` are not in the PDK and must be generated locally
   from the OpenRAM source tree (Docker recipe below).

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

## How to generate (host install)

OpenRAM is intentionally NOT vendored under `external/` because its outputs
are PDK-specific. The reproducible path:

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

## How to generate (Docker, recommended)

If OpenRAM is not installed on the host, the same flow runs in a container
built from the OpenRAM upstream Dockerfile:

```sh
# 1. Clone OpenRAM at a known-good revision.
git clone https://github.com/VLSIDA/OpenRAM external/OpenRAM
cd external/OpenRAM
git checkout f1a72b91                # last commit verified locally

# 2. Build the OpenRAM container (ships ngspice + magic + netgen).
docker build -t openram:f1a72b91 .

# 3. Run the compiler for one e1 target. Outputs land under
#    pd/macros/sky130/<name>/build/ inside the container, which is mounted
#    from the repo so the artifacts persist on the host.
cd ../..
docker run --rm \
    -v "$PWD":/work -w /work \
    -e OPENRAM_HOME=/opt/openram/compiler \
    -e OPENRAM_TECH=/opt/openram/technology \
    openram:f1a72b91 \
    python3 /opt/openram/compiler/openram.py \
        pd/macros/sky130/e1_sram_4kb_1rw/e1_sram_4kb_1rw.openram.config.py

# 4. Promote the artifacts.
mv pd/macros/sky130/e1_sram_4kb_1rw/build/e1_sram_4kb_1rw.lef \
   pd/macros/sky130/e1_sram_4kb_1rw/
# (repeat for .gds, .lib, .spice). Update pd/macros/manifest.yaml.
```

If the OpenRAM upstream Dockerfile does not build cleanly (it depends on
PDK-specific ngspice + magic versions), fall back to running OpenRAM inside
the OpenLane container — it already ships the right SPICE/magic/netgen
stack:

```sh
docker run --rm \
    -v "$PWD":/work -w /work \
    ghcr.io/efabless/openlane2:2.4.0.dev1 \
    bash -lc 'pip install --user openram && \
        python3 ~/.local/bin/openram.py \
        pd/macros/sky130/e1_sram_4kb_1rw/e1_sram_4kb_1rw.openram.config.py'
```

Status today: OpenRAM is NOT installed on this host. The PDK-prebuilt 2 KB
macro is sufficient to flip OpenLane's `Macros` count to 1 and unblock the
AlphaChip / DREAMPlace / OpenROAD post-route PPA evidence loop. The 4 KB /
16 KB / 64 KB macros remain `BLOCKED_run_openram` in the manifest.

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
