# Model card — CircuitNet 3.0 timing/power surrogate

- **Task:** predict per-design timing/power summaries (mean_slack, mean_delay,
  max_at, total_power, ...) from converted CircuitNet 3.0 flow-run records.
- **Code:** `scripts/ai_eda/train_circuitnet3_timing_power_baseline.py` /
  `check_circuitnet3_surrogate.py`.
- **Arch:** dependency-free mean/constant baseline (runs on CPU and on a fresh
  CUDA host before any GNN install). A real heterogeneous GNN is **not yet
  implemented** — that is the next-step net-new model.
- **Data:** 16 of 2004 public CircuitNet 3.0 final cases (bounded local sample),
  split 12/2/2. Public pretraining data only.
- **Metrics (train MAE, illustrative):** mean_slack 0.2458, mean_delay 0.0075,
  max_at 0.3994. Smoke metrics, not an E1 timing/power claim.
- **Claim boundary:** pretraining only; not E1 PPA/signoff. Predictions are
  advisory and never substitute for OpenLane/OpenROAD STA/power.
- **Known limits:** mean baseline (no generalization claim); 16-case sample;
  needs source-level split metadata + full-corpus scale-up + a real GNN before
  it can guide candidate pruning.
