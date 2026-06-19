# pd/openlane — LibreLane 3.0.3 configs

LibreLane (formerly OpenLane 2) configurations for the `e1_chip_top` SoC across
four PDKs. One file per PDK plus a couple of exploratory variants and a small
smoke design.

| File                              | PDK            | Purpose                                              |
| --------------------------------- | -------------- | ---------------------------------------------------- |
| `config.json`                     | `sky130A`      | Default sky130 PD config (stubbed CPU subsystem).    |
| `config.sky130.json`              | `sky130A`      | Full sky130 PD config with CVA6, SRAM macro, PSM.    |
| `config.sky130.exploratory.json`  | `sky130A`      | Sky130 exploratory variant (gates relaxed).          |
| `config.pd-smoke.sky130.json`     | `sky130A`      | Small smoke-test design.                             |
| `config.gf180.json`               | `gf180mcuC`    | Default gf180 PD config.                             |
| `config.gf180.exploratory.json`   | `gf180mcuC`    | gf180 exploratory variant.                           |
| `config.ihp-sg13g2.json`          | `ihp-sg13g2`   | IHP SG13G2 PD config.                                |

## `FP_*` → `IO_PIN_*` / `PDN_*` migration (LibreLane 3.0.3, PR #708)

Upstream [`librelane#708`](https://github.com/librelane/librelane/pull/708)
("feat: the great FP_ removal") renamed all I/O-pin and PDN variables to drop
the legacy `FP_` prefix that LibreLane had inherited from OpenLane 1. The
upstream change preserves `deprecated_names` aliases so old keys still parse,
but they emit deprecation warnings on every load. All seven configs in this
directory have been migrated to the new canonical names.

The exact rename map is checked in at
[`compiler/fp-rename-map.json`](../../compiler/fp-rename-map.json) and was
extracted directly from the PR diff (`librelane/steps/common_variables.py`,
`librelane/steps/odb.py`, `librelane/steps/openroad.py`).

### Renames applied in this directory

| Old (`FP_*`)                | New                       |
| --------------------------- | ------------------------- |
| `FP_PIN_ORDER_CFG`          | `IO_PIN_ORDER_CFG`        |
| `FP_PDN_VPITCH`             | `PDN_VPITCH`              |
| `FP_PDN_HPITCH`             | `PDN_HPITCH`              |
| `FP_PDN_VWIDTH`             | `PDN_VWIDTH`              |
| `FP_PDN_HWIDTH`             | `PDN_HWIDTH`              |
| `FP_PDN_VSPACING`           | `PDN_VSPACING`            |
| `FP_PDN_HSPACING`           | `PDN_HSPACING`            |
| `FP_PDN_CORE_RING`          | `PDN_CORE_RING`           |
| `FP_PDN_CORE_RING_VWIDTH`   | `PDN_CORE_RING_VWIDTH`    |
| `FP_PDN_CORE_RING_HWIDTH`   | `PDN_CORE_RING_HWIDTH`    |
| `FP_PDN_CORE_RING_VOFFSET`  | `PDN_CORE_RING_VOFFSET`   |
| `FP_PDN_CORE_RING_HOFFSET`  | `PDN_CORE_RING_HOFFSET`   |
| `FP_PDN_CORE_RING_VSPACING` | `PDN_CORE_RING_VSPACING`  |
| `FP_PDN_CORE_RING_HSPACING` | `PDN_CORE_RING_HSPACING`  |
| `FP_PDN_VERTICAL_LAYER`     | `PDN_VERTICAL_LAYER`      |
| `FP_PDN_HORIZONTAL_LAYER`   | `PDN_HORIZONTAL_LAYER`    |

### Kept unchanged (not touched by PR #708)

`FP_SIZING`, `FP_CORE_UTIL`, `FP_ASPECT_RATIO`, `FP_MACRO_HORIZONTAL_HALO`,
`FP_MACRO_VERTICAL_HALO`, `FP_IO_HLAYER`, `FP_IO_VLAYER`, `FP_DEF_TEMPLATE` —
these are Floorplan-step variables (not PDN/IO-pin) and remain canonical under
the `FP_` prefix in LibreLane 3.0.3.

## Parse-only validation

LibreLane has no `--dry-run` flag. To validate a config without running the
full flow, instantiate the `Classic` flow which performs full schema validation
and PDK resolution at construction time:

```bash
. tools/env.sh
external/librelane/.venv/bin/python3 - <<'PY'
from pathlib import Path
from librelane.flows import Flow

repo = Path(".")
sky_root = repo / "external/pdks/volare/sky130/versions/c6d73a35f524070e85faff4a6a9eef49553ebc2b"

Classic = Flow.factory.get("Classic")
Classic(
    config=str(repo / "pd/openlane/config.sky130.json"),
    design_dir=str(repo / "pd/openlane"),
    pdk="sky130A",
    pdk_root=str(sky_root),
    scl="sky130_fd_sc_hd",
)
print("PARSED OK")
PY
```

Successful construction means the schema accepts every key and the PDK
resolved. Any remaining warnings will mention unrelated deprecations
(`SYNTH_BUFFERING`, `PL_TARGET_DENSITY`, `GRT_ANT_ITERS`, etc.) — those are
separate cleanups outside the scope of PR #708.
