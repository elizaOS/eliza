# Model card — CircuitNet 3.0 timing/power surrogate

- **Task:** predict six per-design timing/power summaries (`min_slack`,
  `mean_slack`, `max_at`, `mean_delay`, `mean_slew`, `total_power`) from converted
  CircuitNet 3.0 graph-sample records.
- **Two models, same targets, head-to-head on the same held-out split:**
  1. **Mean baseline** (`train_circuitnet3_timing_power_baseline.py`) —
     dependency-free train-split mean/constant predictor. This is the documented
     baseline to beat; it runs on any CPU/CUDA host with zero install.
  2. **Heterogeneous GNN** (`circuitnet3_gnn.py` +
     `train_circuitnet3_gnn.py`) — the net-new learned model.
- **Checker:** `check_circuitnet3_surrogate.py` (validates the baseline run).

## GNN architecture (`circuitnet3_gnn.py`)

Pure-PyTorch (no torch-geometric — not installed on this CPU host), so it trains
single-threaded on CPU. The model operates on the real netlist graph recovered
during conversion:

- **Nodes** are cell instances. Features = 7 standardized numeric attributes
  (`drive_strength`, `fanout_num`, `fanout_res`, `fanout_load_mean`, `at`,
  `slack`, `setup_mean`) imputed to the train-set column mean when missing, plus a
  learned 8-d embedding over 13 cell-family buckets (NAND/NOR/AND/OR/XOR/XNOR/
  INV/BUF/MX/DFF/AOI/OAI/OTHER) keyed off the standard-cell name prefix.
- **Edges** are the `net_fanout` driver→sink edges parsed from `final_netlist.v`
  (single structural driver per net fanning out to its consumers) — the real
  inter-cell topology, not summary statistics.
- **Message passing:** 3 `RelationalConv` layers. Each layer has separate learned
  transforms for the self-loop, the forward-fanout relation, and the reverse
  relation, with mean aggregation per relation — a heterogeneous relational view.
  LayerNorm + ReLU + dropout + residual per layer.
- **Readout:** concatenated mean+max global pool → 2-layer MLP → 6 regression
  heads. Targets are standardized with train-set mean/std; loss is masked MSE so
  designs missing a label do not contribute to that target.

Hyperparameters: hidden_dim=64, family_dim=8, num_layers=3, dropout=0.1, Adam
lr=5e-3, weight_decay=1e-4, grad-clip 5.0, early stopping on val MSE
(patience=25), seed=17.

## Data

- **2004 of 2004** public CircuitNet 3.0 `dataset/Final` cases converted via
  `convert_circuitnet3_to_internal_records.py --all-records` into
  `build/ai_eda/circuitnet3/validation/records` (6012 internal records:
  design_bundle + graph_sample + flow_run per case).
- Deterministic sorted-`case_id` 80/10/10 split: **1604 train / 200 val / 200
  test**. Public pretraining data only.
- The `--sample-limit 16` Makefile path is retained for fast schema verification.

## Measured held-out metrics (test split, GNN vs mean baseline)

Test MAE in target units; lower is better. `rel. improvement` =
`(baseline_mae − gnn_mae) / baseline_mae`.

| Target | GNN test MAE | Baseline test MAE | Rel. improvement | GNN beats baseline |
| --- | --- | --- | --- | --- |
| min_slack | <FILL_MIN_SLACK_GNN> | <FILL_MIN_SLACK_BASE> | <FILL_MIN_SLACK_IMPR> | <FILL_MIN_SLACK_WIN> |
| mean_slack | <FILL_MEAN_SLACK_GNN> | <FILL_MEAN_SLACK_BASE> | <FILL_MEAN_SLACK_IMPR> | <FILL_MEAN_SLACK_WIN> |
| max_at | <FILL_MAX_AT_GNN> | <FILL_MAX_AT_BASE> | <FILL_MAX_AT_IMPR> | <FILL_MAX_AT_WIN> |
| mean_delay | <FILL_MEAN_DELAY_GNN> | <FILL_MEAN_DELAY_BASE> | <FILL_MEAN_DELAY_IMPR> | <FILL_MEAN_DELAY_WIN> |
| mean_slew | <FILL_MEAN_SLEW_GNN> | <FILL_MEAN_SLEW_BASE> | <FILL_MEAN_SLEW_IMPR> | <FILL_MEAN_SLEW_WIN> |
| total_power | <FILL_TOTAL_POWER_GNN> | <FILL_TOTAL_POWER_BASE> | <FILL_TOTAL_POWER_IMPR> | <FILL_TOTAL_POWER_WIN> |

Source: `build/ai_eda/circuitnet3_gnn/validation/metrics.json` (GNN) and
`build/ai_eda/circuitnet3_surrogate/validation/metrics.json` (baseline), both on
the identical 200-case test split. Run id `validation`, best epoch
<FILL_BEST_EPOCH>.

## Claim boundary

Pretraining only; **not** an E1 PPA/signoff claim. CircuitNet labels are public
45nm dataset values, never substituted for local OpenLane/OpenROAD STA/power.
Predictions are advisory and gate nothing in release. `release_use_allowed` is
`false` in every emitted artifact.

## Known limits

- Public-corpus generalization only; no contamination/overlap audit yet between
  CircuitNet and any E1 evaluation set — required before any model-guided change
  is accepted.
- Design-level summary regression only (no per-net congestion / per-path slack).
- Split is by sorted `case_id`, not by source design family, so cross-family
  generalization is not yet isolated.
