# e1_chip_top Antenna Metadata Blocker - 2026-05-18

## Scope

This report covers the OpenLane warning emitted by
`Odb.CheckDesignAntennaProperties` in the selected full-chip SKY130 run:

`pd/openlane/runs/RUN_2026-05-18_05-41-42/61-odb-checkdesignantennaproperties/report.yaml`

The warning is metadata-specific. It is separate from routed antenna-violation
repair/check reports and separate from padframe-inclusive ESD signoff.

## Findings

OpenLane reports missing antenna metadata on these `e1_chip_top` pins:

| Direction | Missing metadata | Pins |
| --- | --- | --- |
| input | gate information | `JTAG_TCK`, `JTAG_TDI`, `JTAG_TMS`, `TEST_MODE` |
| output | diffusion information | `DBG_READY`, `JTAG_TDO` |

The generated macro LEF confirms these pins have no corresponding
`ANTENNAGATEAREA` or `ANTENNADIFFAREA` entries:

`pd/openlane/runs/RUN_2026-05-18_05-41-42/final/lef/e1_chip_top.lef`

## Local disposition

No foundry pad cells are instantiated in `rtl/top/e1_chip_top.sv`; the
current top level is still a padless digital core wrapper. The affected JTAG
and test inputs are not connected to meaningful internal scan/debug logic in
the hardened macro, and `JTAG_TDO` is tied off. Adding arbitrary antenna
properties to the generated LEF would hide the warning without proving a
fabricatable pad-ring solution.

The local fix is therefore fail-closed:

- `scripts/check_antenna_metadata.py` records the exact pins reported by
  OpenLane.
- The default check passes only while `pd/padframe/e1_demo_padframe.yaml`
  keeps `padframe_release.blocked: true`.
- `scripts/check_antenna_metadata.py --release` fails until the warning is
  eliminated or formally dispositioned with real pad-cell evidence.

## Required release work

Release remains blocked until one of these is true:

1. Selected foundry IO, ESD, power, ground, corner, and filler pad cells are
   instantiated around `e1_chip_top`, and padframe-inclusive DRC/LVS/antenna
   reports are archived.
2. The affected top-level wrapper pins are removed from the release top or
   connected to real, tested internal logic such that OpenLane emits valid
   antenna gate/diffusion metadata without hand-edited LEF claims.

Do not mark the antenna/padframe gate release-ready from this report alone.

## Issued workstreams

| Workstream | Assignment | Exit criteria |
| --- | --- | --- |
| Antenna metadata checker | Keep `scripts/check_antenna_metadata.py` wired into scaffold and release gates. | Default check documents the blocker; `--release` fails on any missing top-level metadata. |
| RTL wrapper cleanup | Decide whether `TEST_MODE`, JTAG pins, `DBG_READY`, and `JTAG_TDO` are real release IO or scaffold-only signals. | Unused pins are removed from release top, or connected to real tested logic that yields valid antenna metadata. |
| Padframe integration | Select and instantiate foundry IO, power, ground, ESD, and corner cells. | Padframe-inclusive DRC/LVS/antenna evidence replaces padless-core evidence. |
| Signoff archive | Archive final antenna, STA/DRV, DRC, LVS, SPEF/SDF, and manifest outputs from one selected run. | `make product-release-check` no longer reports antenna metadata or padframe blockers. |
