# OpenLane Smoke Baseline - 2026-05-19

Run:

```sh
OPENLANE_TIMEOUT_SECONDS=900 scripts/run_openlane.sh --smoke
```

Result: completed successfully.

Final artifacts:

- `pd/openlane/runs/RUN_2026-05-19_03-33-45/final/def/e1_pd_smoke_top.def`
- `pd/openlane/runs/RUN_2026-05-19_03-33-45/final/gds/e1_pd_smoke_top.gds`
- `pd/openlane/runs/RUN_2026-05-19_03-33-45/final/odb/e1_pd_smoke_top.odb`
- `pd/openlane/runs/RUN_2026-05-19_03-33-45/final/metrics.json`

Key metrics from `metrics.json`:

| Metric | Value |
| --- | ---: |
| Die area | 32400 |
| Core area | 18955.7 |
| Instance count | 391 |
| Standard cells | 391 |
| Hard macros | 0 |
| Macro area | 0 |
| Stdcell area | 1327.52 |
| Utilization | 0.070033 |
| Routed wire length | 3563 |
| Vias | 540 |
| Magic DRC errors | 0 |
| LVS errors | 0 |
| Antenna violating nets | 0 |
| Setup WNS | 13.217552759742512 |
| Setup TNS | 0 |
| Hold WNS | 0.13569576402164535 |
| Hold TNS | 0 |
| Max slew violations | 0 |
| Max cap violations | 0 |

Interpretation: this validates the local OpenLane/signoff path, but the design
has no hard macros. It is not a meaningful AlphaChip macro-placement benchmark.

## AlphaChip handoff smoke

The final DEF converts to Circuit Training protobuf and initial PLC:

```sh
ALPHACHIP_OUT_DIR=/tmp/e1-alphachip/smoke_handoff \
  scripts/alphachip/convert_lefdef_to_pb.sh \
  --def pd/openlane/runs/RUN_2026-05-19_03-33-45/final/def/e1_pd_smoke_top.def
```

Generated:

- `/tmp/e1-alphachip/smoke_handoff/e1_pd_smoke_top.pb.txt`
- `/tmp/e1-alphachip/smoke_handoff/e1_pd_smoke_top.init.plc`

The PLC contains only ports and reports zero hard or soft macros.
