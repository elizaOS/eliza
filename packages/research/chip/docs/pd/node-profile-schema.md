# Node profile & PDK adapter seam (`eliza.pd_node_profile.v1`)

Node identity used to be duplicated across four files per node:

- `pd/<node>-stub/access-gate.yaml` (advanced nodes only)
- `pd/corner-manifests/<node>.yaml`
- `pd/library-manifests/<node>.yaml`
- one row in `pd/openlane/portability-index.yaml`

`pd/node-profiles/<node_id>.yaml` is the documented single source of truth for
node identity. The four files above become cross-checked downstream:
`scripts/build_node_profile.py` derives the expected identity from the
portability-index row plus the access-gate and asserts the profile agrees with
all of them, reporting drift and exiting non-zero on any mismatch. It never
rewrites the four files.

## Canonical node IDs

`sky130`, `gf180`, `ihp-sg13g2`, `asap7`, `tsmc-n2p`, `tsmc-a14`, `intel-14a`,
`samsung-sf2p`. The profile filename stem must equal `node_id`.

## Schema

```yaml
schema: eliza.pd_node_profile.v1
node_id: <canonical id>
foundry: <foundry>                       # must match the portability-index row
status: open_fabricable | predictive_shape_only | blocked_until_foundry_agreement
fabricable: <bool>                       # true only for open_fabricable
bspdn: <bool>                            # backside power delivery in the baseline node
bump_pitch_um: <number|null>             # null unless publicly stated in a source file
metal_stack: <string|null>               # null for blocked nodes; else matches the index row
pdk_adapter: <mapping|null>              # see below
default_corner_manifest: pd/corner-manifests/<node>.yaml
source_files:
  access_gate: pd/<node>-stub/access-gate.yaml | null   # null for non-advanced nodes
  corner_manifest: pd/corner-manifests/<node>.yaml
  library_manifest: pd/library-manifests/<node>.yaml
  portability_index_id: <id of the portability-index row>
forbidden_claims_until_unblocked: [<claim>, ...]         # required for blocked nodes
```

### The adapter seam (`pdk_adapter`)

The adapter is the only place a node declares how it is actually built. It is a
real seam, not a pointer at a procurement gate.

- **Open / predictive nodes** (`open_fabricable`, `predictive_shape_only`)
  carry a non-null `pdk_adapter`:

  ```yaml
  pdk_adapter:
    openlane_config: pd/openlane/config.<node>.json   # or pd/asap7/config.asap7.yaml (ORFS)
    flow: openlane2 | openroad_orfs
    pdk_key: <PDK>                  # equals the config.json PDK key for OpenLane lanes
    std_cell_library: <lib>         # equals the config.json STD_CELL_LIBRARY key
    max_routing_layer: <layer>
    corner_views:
      library_manifest: pd/library-manifests/<node>.yaml
      corner_manifest: pd/corner-manifests/<node>.yaml
  ```

  For OpenLane (`.json`) configs, `build_node_profile.py` opens the real config
  and asserts `pdk_key == PDK` and `std_cell_library == STD_CELL_LIBRARY`. ORFS
  (`.yaml`) configs (ASAP7) do not use those JSON keys and are exempt from that
  specific cross-check.

- **Advanced (NDA-locked) nodes** (`blocked_until_foundry_agreement`) set
  `pdk_adapter: null` and add `pdk_adapter_blocked_reason`. There is no real
  adapter until a foundry agreement and a commercial signoff EDA seat exist.
  These nodes carry `forbidden_claims_until_unblocked` lifted from their
  access-gate file (the profile list must be a subset of the access-gate list).

## Fail-closed law (`scripts/check_node_profile.py`)

The fail-closed gate rejects any advanced node flipped toward fabricability:
non-blocked `status`, `fabricable != false`, a non-null `pdk_adapter`, or an
empty `forbidden_claims_until_unblocked`. It mirrors the rejection intent of
`scripts/test_pdk_portability.py::test_rejects_unblocked_advanced_node` at the
node-profile layer. No fabricable claim, Liberty/LEF/GDS reference, or PPA
number for `tsmc-n2p`, `tsmc-a14`, `intel-14a`, or `samsung-sf2p` may be
introduced through this surface.

## Corner cross-product expansion (`scripts/expand_corners.py`)

Corner manifests carry required corner axes plus `total_effective_corners_min`,
but the cross-product was never expanded or asserted. `expand_corners.py` reads
a corner manifest and expands `PVT × Vt × RC × aging`:

- **Advanced (blocked) manifests** expand the Cartesian product of the axes
  under `required_after_unblock` (`process × voltage_v × temperature_c × aging
  × rc × multi_vt_required`) and assert it is `>= total_effective_corners_min`.
  A manifest whose product falls short fails closed.
- **Open / predictive manifests** enumerate concrete `pvt_corners`,
  `rc_corners`, and `vt_mix.available`; the realized product is reported. These
  declare no minimum, so the assertion is skipped.

Output is a machine-readable corner set keyed by `node_id`
(`eliza.pd_corner_expansion.v1`) at
`docs/evidence/process/corner-expansion.json`.

## Checks

```bash
make node-profile-check    # build_node_profile.py + check_node_profile.py
make corner-expand-check   # expand_corners.py
python3 scripts/test_node_profile.py
python3 scripts/test_expand_corners.py
```
