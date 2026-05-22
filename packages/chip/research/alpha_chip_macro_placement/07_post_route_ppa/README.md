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
  openroad.json              OpenROAD baseline post-route PPA (softmacro .plc flow)
  alphachip.json             AlphaChip candidate post-route PPA (softmacro .plc flow)
  dreamplace.json            DREAMPlace 4.0 candidate post-route PPA (softmacro .plc flow)
  comparison.json            optional aggregate (delta wirelength / TNS / DRC)
  macro_array_baseline_4x2.json   E1 weight-buffer array, 4x2 grid (measured)
  macro_array_compact_4x2.json    E1 weight-buffer array, compact 4x2 (measured)
  macro_array_stack_2x4.json      E1 weight-buffer array, 2x4 stack (measured)
  macro_array_comparison.json     post-route ranking + False-Dawn verdict
```

The `macro_array_*.json` files are REAL measured post-route PPA for the eight
movable-Sky130-SRAM `e1_npu_weight_buffer_array` experiment. Each is extracted
from its OpenLane run's `62-checker-xor/state_out.json` (post-detailed-route).
The `comparison` verdict records the discipline outcome: the wirelength/TNS
proxy winner (`stack_2x4`) REGRESSES post-route signoff (+4 antenna nets, +156
max-slew, +1 max-fanout) and is rejected as an optimization win
(`optimization_claim_allowed: false`). AI candidates only approximate these
routed placements (nearest mean displacement 57-806 um); none reproduces a
measured cfg within legalizer tolerance, so none inherits measured PPA — each
distinct candidate requires its own OpenLane route.

The softmacro `openroad.json` / `alphachip.json` / `dreamplace.json` `.plc`
flow remains BLOCKED on the AlphaChip softmacro benchmark
(`/tmp/e1-alphachip/e1_softmacro/*.pb.txt` + `.plc`) and the
`circuit_training:e1-r0.0.4` image. The release flow has Macros: 0 there, so
detailed route on an AlphaChip `.plc` will not move metrics relative to the
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
