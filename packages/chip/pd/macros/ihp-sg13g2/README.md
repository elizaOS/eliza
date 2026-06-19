# IHP SG13G2 hard SRAM macros (open PDK compiler)

IHP SG13G2 is a 130 nm BiCMOS open PDK from IHP-GmbH. SRAM macros come from
the `IHP-Open-PDK` distribution, which ships RAM compiler configs and
pre-characterized blocks rather than a Python source compiler. These macros
exist purely as a **portability target** so the e1 floorplan and AlphaChip
flow demonstrate they are not Sky130-specific.

## What goes here

For each target macro `<name>` in `pd/macros/manifest.yaml`:

```
pd/macros/ihp-sg13g2/<name>/
  <name>.lef
  <name>.gds
  <name>.lib
  <name>.spice
  <name>.compiler.yaml          IHP SRAM compiler input
  README.md                     pin map, halo, dimensions
```

The compiler config records the exact macro shape, retention, and process
options chosen so the generation step is reproducible.

## How to generate

```sh
git clone https://github.com/IHP-GmbH/IHP-Open-PDK external/IHP-Open-PDK
cd external/IHP-Open-PDK
git rev-parse HEAD                                  # pin this in manifest.yaml
# Follow the SG13G2 SRAM compiler README under
# ihp-sg13g2/libs.ref/sg13g2_sram/<size>
```

Outputs land in the per-size LEF/GDS/Liberty directories. Copy the verified
artifacts into `pd/macros/ihp-sg13g2/<name>/` and update
`pd/macros/manifest.yaml` to point at them.

## Why SG13G2 portability matters for 2028

The 2028 target node is sub-7 nm; Sky130 is closure methodology only. SG13G2
keeps the open PDK contract honest by proving the floorplan, AlphaChip
protobuf, DREAMPlace harness, and OpenROAD detailed routing all work across
two open PDKs before any commercial-EDA partnership lands.
