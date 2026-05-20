# 07_post_route_ppa — Routed PPA truth for AlphaChip candidates

This directory holds the JSON outputs of `scripts/run_post_route_ppa.py`.
Each file is the *post-route* PPA capture for one placement candidate:
AlphaChip, DREAMPlace 4.0, or the OpenROAD baseline. The validator
re-runs OpenROAD detailed route on the candidate `.plc` and records:

- routed wirelength
- DRC count
- congestion histogram
- hold and setup TNS / WNS
- max-slew and max-cap violations
- post-route power (when available)

This is the *truth* dataset that disciplines the macro-placement
evidence gate. Proxy cost alone is not enough — see
`docs/pd/macro-placement.md` for the False Dawn (arXiv 2302.11014)
context.

## Expected files

```
07_post_route_ppa/
  README.md                  this file
  openroad.json              OpenROAD baseline post-route PPA
  alphachip.json             AlphaChip candidate post-route PPA
  dreamplace.json            DREAMPlace 4.0 candidate post-route PPA
  comparison.json            optional aggregate (delta wirelength / TNS / DRC)
```

Today every JSON above is BLOCKED on the hard-macro inventory landing
(`pd/macros/manifest.yaml`). The release flow has Macros: 0 so detailed
route on an AlphaChip `.plc` will not move metrics relative to the
baseline.

## How to populate

For OpenROAD baseline:

```sh
scripts/run_post_route_ppa.py \
    --plc /tmp/e1-alphachip/e1_softmacro/e1_softmacro.openroad.plc \
    --netlist /tmp/e1-alphachip/e1_softmacro/e1_softmacro.pb.txt \
    --openroad-run-dir pd/openlane/runs/<RUN_TAG> \
    --openlane-config pd/openlane/config.sky130.json \
    --out-json research/alpha_chip_macro_placement/07_post_route_ppa/openroad.json \
    --skip-route
```

For AlphaChip candidate (after PPO training converges on Nebius H200):

```sh
scripts/run_post_route_ppa.py \
    --plc /tmp/e1-alphachip/e1_softmacro_train/run_00/eval_output/best.plc \
    --netlist /tmp/e1-alphachip/e1_softmacro/e1_softmacro.pb.txt \
    --openroad-run-dir pd/openlane/runs/<RUN_TAG_FROM_RE_ROUTE> \
    --openlane-config pd/openlane/config.sky130.json \
    --out-json research/alpha_chip_macro_placement/07_post_route_ppa/alphachip.json
```

For DREAMPlace candidate:

```sh
scripts/dreamplace_eval.py \
    --bench-dir /tmp/e1-alphachip/e1_softmacro \
    --out-dir build/pd/dreamplace/e1 \
    --use-gpu

scripts/run_post_route_ppa.py \
    --plc build/pd/dreamplace/e1/dreamplace.placement.plc \
    --netlist /tmp/e1-alphachip/e1_softmacro/e1_softmacro.pb.txt \
    --openroad-run-dir pd/openlane/runs/<RUN_TAG_FROM_RE_ROUTE_DP> \
    --openlane-config pd/openlane/config.sky130.json \
    --out-json research/alpha_chip_macro_placement/07_post_route_ppa/dreamplace.json
```

## Acceptance contract

Each JSON file must validate against `schema: eliza.pd_post_route_ppa.v1`
and contain every key listed in
`docs/evidence/pd/post-route-ppa-validator.yaml#required_metric_keys`.
