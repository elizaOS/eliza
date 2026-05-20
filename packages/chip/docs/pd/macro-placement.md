# Macro Placement — AlphaChip, DREAMPlace, and OpenROAD Baseline

## Scope

This document records the e1 macro-placement strategy across three placers,
the post-route PPA validator that disciplines all three, and the "False Dawn"
controversy that frames the entire effort. It is the human-readable companion
to `docs/evidence/pd/macro-placement-evidence.yaml` and
`research/alpha_chip_macro_placement/07_post_route_ppa/`.

## Three placers under evaluation

| Placer | Class | License | RL training cost | What it produces |
| --- | --- | --- | --- | --- |
| OpenROAD (RTL-MP + macro placement step) | analytical + simulated annealing | open | none | baseline `.plc` per release run |
| AlphaChip (Google Circuit Training r0.0.4) | reinforcement-learning policy | open (Apache 2.0) | 8x V100 or 1x H200 multi-day | candidate `.plc` from a trained policy |
| DREAMPlace 4.0 | GPU-accelerated analytical | open | none | candidate `.plc`; macro_place_flag=1 |

All three placers emit a Circuit Training `.plc` (or DEF that we convert to
`.plc` via `scripts/alphachip/convert_lefdef_to_pb.sh`). That gives us one
common interchange format and one validator.

## The validator: `scripts/run_post_route_ppa.py`

AlphaChip publishes a **proxy cost** (`wirelength_cost + 0.5 * congestion_cost
+ 0.5 * density_cost`). The arXiv 2302.11014 "False Dawn" critique
demonstrated that proxy improvements do not always translate to routed-PPA
improvements after detailed route. Our discipline is:

1. Run every placer; capture proxy cost (`compare_proxy_costs.sh`).
2. Re-run OpenROAD detailed route on each candidate `.plc`
   (`run_post_route_ppa.py`).
3. Compare routed wirelength, DRC count, congestion histogram, hold/setup
   TNS, max-slew/cap violations, and post-route power.
4. Reject any candidate whose post-route PPA is worse than the OpenROAD
   baseline, regardless of proxy delta.

`compare_proxy_costs.sh` is now wired to call the validator after the proxy
step so the two deltas land in the same output directory.

## Current e1 numbers

Captured under
`research/alpha_chip_macro_placement/05_experiments/` and
`research/alpha_chip_macro_placement/06_e1_notes/`:

### 16-macro smoke (toy benchmark)

| Placer | Proxy cost |
| --- | ---: |
| OpenROAD baseline | 0.499 |
| AlphaChip (toy training) | 0.761 |

**Interpretation:** AlphaChip is **worse** here. The toy training run does
not converge in a handful of iterations; this is consistent with the
upstream Ariane recipe needing many-hour PPO runs.

### 256-macro full release (e1 softmacro benchmark)

| Placer | Proxy cost |
| --- | ---: |
| OpenROAD baseline | 0.2379 |
| AlphaChip (longer run) | 0.2308 |
| Delta | -3.01 % proxy |

**Interpretation:** AlphaChip wins on proxy by 3 %. That is **not** PPA yet.
The post-route PPA validator is BLOCKED until we have hard macros in the
floorplan; see `pd/macros/manifest.yaml`. Without hard macros the AlphaChip
proxy win has zero PPA leverage because there is nothing to place.

## The "False Dawn" controversy — honest summary

The Mirhoseini et al. Nature 2021 paper claimed RL placement beat human
designers on Google TPU blocks. Cheng et al. 2023 (arXiv 2302.11014)
re-ran the experiment with reproducibility-strict protocol and found:

- The published proxy gains were not always reproducible.
- When reproduced, proxy gains did not consistently translate to routed
  wirelength or post-route timing improvements.
- The original paper compared to simulated annealing, not the
  state-of-the-art commercial placer (Innovus / Genus).

Google responded with the AlphaChip rebrand and updated benchmarks; the
debate is not settled. Our position:

- Treat AlphaChip as **one** candidate placer, not a guaranteed win.
- Always validate **routed PPA**, never proxy alone.
- Compare against OpenROAD's macro placer and DREAMPlace's macro placement,
  not a hand-tuned annealer.
- Track the **PPO training cost** (8x V100 days or 1x H200 days) in the
  scorecard. If a placer requires GPU-days of training to match an
  analytical placer's output in seconds, the analytical placer wins on the
  cost dimension that matters for the 2028 schedule.

## Blocked steps

- **PPO RL training** for an e1-specific policy is BLOCKED on H200 GPU
  access. The Nebius H200 runbook is concrete; the actual run has not
  executed.
- **Post-route PPA truth** is BLOCKED on hard macros existing (OpenRAM
  Sky130 macros not yet built). See `pd/macros/manifest.yaml`.
- **Commercial-EDA placer comparison** (Innovus + Genus) is BLOCKED on the
  commercial EDA gate (`docs/evidence/pd/commercial-eda-gate.yaml`).

## What unblocks the macro-placement evidence gate

1. At least one OpenRAM Sky130 macro produces verified LVS-clean GDS and is
   placed in the OpenLane Sky130 release.
2. `compare_proxy_costs.sh` runs both proxy AND post-route PPA for the
   OpenROAD baseline and at least one alternative placer (AlphaChip or
   DREAMPlace).
3. The PPA JSON for both placers is archived under
   `research/alpha_chip_macro_placement/07_post_route_ppa/`.
4. The macro-placement-evidence.yaml gate transitions to
   `complete_local_evidence`.

Until then the gate fails closed.
