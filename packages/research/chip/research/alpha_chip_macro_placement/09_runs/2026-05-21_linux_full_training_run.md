# AI-EDA full training + verification run — 2026-05-21 (Linux x86_64 host)

Host: Linux x86_64, 30 GiB RAM, no working CUDA driver (`nvidia-smi` fails),
325 GiB free disk. All training in this run is CPU or dependency-free. Heavy
GPU/RL lanes are addressed separately (see `12_max_trained_assessment_2026-05-21.md`).

Run id: `validation` (canonical) plus `linux-*` audit ids. Tool versions:
OpenLane 2.4.0.dev1 (pinned Docker image `ghcr.io/efabless/openlane2:2.4.0.dev1`),
native LibreLane 3.0.3 + oss-cad-suite on PATH via `tools/env.sh`, PyTorch
2.12.0+cpu.

## What changed versus the prior (Mac) state

The prior plan/eval state in `08_full_stack_ai_chip_optimization_plan_2026-05-20.md`
was captured on a 128 GiB M4 (MPS, no CUDA). Two pending plan items were
unblocked on this host:

- **Deterministic E1 OpenLane signoff now exists locally.** The `pd-smoke`
  SKY130 flow (`e1_pd_smoke_top`) ran end-to-end to `final/metrics.json`:
  366 instances, die 32400 um^2, core 18955.7 um^2, setup WS +13.14 ns,
  hold WS +0.14 ns, setup/hold TNS 0, route wirelength 1959, route DRC 0,
  antenna violations 0, total power 1.02e-4 mW. 284 raw metrics.
- **`eda.flow_run.v1` now carries real labels.** `parse_openlane_metrics_to_flow_run.py`
  selected the completed run (`metrics_selection_policy=latest_local_openlane_run`,
  `deterministic_run_artifacts_present=True`) and normalized 284 metrics into
  the required label set. The PD surrogate smoke (`train_pd_surrogate_smoke.py`)
  now trains on this real label rather than the checked-in fixture.

The full `e1_chip_top` SKY130 release flow was also launched and reached
timing-driven global placement (Nesterov converging, overflow ~0.16); detailed
routing of the full chip-top is long-running and tracked separately.

## Corpora pulled + converted (real payloads, this host)

Fetched into ignored `external/**/payload/` and converted to internal
`eda.*.v1` records:

| Corpus | Payload | Converted |
| --- | --- | --- |
| TILOS MacroPlacement | 4.1 GB | 16 cases / 48 records (Ariane, BlackParrot, MemPool, NVDLA) |
| ChiPBench-D | 2.5 GB | 4 of 20 cases / 12 records |
| CircuitNet 3.0 | ~1 GB | 16 of 2004 cases / 48 records |
| OpenABC-D | 271 MB | 2 benches / 6 records |
| EDALearn | 334 MB | 8 designs / 24 records |
| AiEDA/iDATA | 222 MB | 3 maps / 9 records |
| OpenROAD EDA Corpus | 8.9 MB | 2116 instruction records (1691/206/219) |

Conversions are deliberately bounded local samples; scaling case counts is a
knob (`--limit`-style) carried into the CUDA run plan, not a code gap.

## Models trained + verified (CPU / dependency-free)

| Model | Script | Result |
| --- | --- | --- |
| Macro-placement PyTorch regressor | `train_macro_placement_torch_regressor.py` | device=cpu, 25 epochs, train/val/test 2340/200/240; test mean-L1/core 0.2646, orientation acc 0.454; loss 0.301→0.226. Inference emitted 18 quarantined candidates, 6 blocked. |
| Macro-placement supervised imitation | `train_macro_placement_supervised_model.py` | dependency-free mean-prior, 2340/200/240; 18 candidates, 6 blocked. |
| Macro-placement deterministic baselines | `train_macro_placement_policy.py` | 20 cases, 133 candidates across 7 policies (center/grid/repair + CT/SA/Hier-RTLMP/ChipDiffusion proxies), 1 fixed-only case blocked. |
| CircuitNet3 timing/power surrogate | `train_circuitnet3_timing_power_baseline.py` | 16 samples (12/2/2); per-target MAE recorded (e.g. mean_slack train MAE 0.246). Pretraining only. |
| PD surrogate | `train_pd_surrogate_smoke.py` | trained on **real** E1 OpenLane flow-run label. |
| Logic-synthesis recipe baseline | `run_logic_synthesis_policy_baseline.py` | real Yosys/ABC: 6 recipes passed, 4 blocked, 0 failed. |

Combined candidate ranking: 169 candidates across 41 placement cases. Full
replay plan: `ready=0, blocked=169` (fail-closed). Replay preflight against the
now-present local OpenLane returns `PASS_BLOCKED` with the precise reason:
*"abstract E1 softmacro case must become real LEF/DEF/OpenLane macro case"* and
*"candidate is not marked READY_FOR_DETERMINISTIC_REPLAY"* — i.e. the blocker is
E1 design maturity (no movable macros), not tooling.

## Gate verification

- `make docs-check` (run id `validation`): **PASS** (exit 0). 36 domain
  target captures, source inventory 587 entries / 50 backlog, 41 external
  assets, 21 intake manifests, internal schemas/fixtures, candidate + tool-action
  schemas, cocotb dry run. AlphaChip checkpoint blocker: `PASS_BLOCKED_CURRENT`.
- `make ai-eda-bootstrap-metadata`: PASS.
- Every trained-model checker (`check_*`) passed against its artifact.

All training/inference artifacts remain quarantined (`release_use_allowed=false`)
and make no E1 PPA, signoff, or release claim.

## Max-training pass (saturation evidence)

To confirm the small models are at capacity rather than under-trained:

- **Torch regressor at 200 epochs** (vs. 25-epoch smoke): train loss
  0.22631 → 0.17234, train L1/core 0.24658 → 0.23715, but **val L1 0.24483 and
  test L1 0.26478 plateaued** (unchanged within noise). This is the signature of
  a saturated tiny MLP — additional epochs reduce train loss only (mild overfit
  onset), so the model is trained to its architectural ceiling. A larger gain
  needs graph/timing features (net-new model), not more epochs.
- **CircuitNet3 surrogate scaled 16 → 128 cases** (run id
  `linux-maxtrain-20260521`, 384 records, split 102/13/13): converts cleanly and
  retrains. Because the current surrogate is a mean baseline, more cases stabilize
  the means but do not change the architecture's ceiling; a heterogeneous GNN is
  the next-step net-new model. Full 2004-case conversion is a `--sample-limit`
  knob, not a code gap.

Conclusion: the trainable models here are trained to the limit of their current
(small) architectures and the available E1 evidence. See
`12_max_trained_assessment_2026-05-21.md`.
