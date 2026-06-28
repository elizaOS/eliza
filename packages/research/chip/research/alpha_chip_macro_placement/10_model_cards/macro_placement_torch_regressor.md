# Model card — macro-placement PyTorch regressor

- **Task:** predict normalized macro `(x, y)` + orientation per placement case.
- **Code:** `scripts/ai_eda/train_macro_placement_torch_regressor.py` /
  `infer_macro_placement_torch_regressor.py`.
- **Arch:** small MLP regressor (per-macro feature → normalized position +
  orientation logits). Device-agnostic (`--device auto`: cuda/mps/cpu).
- **Data:** `eda.macro_placement` supervised JSONL splits — TILOS
  MacroPlacement + bounded ChiPBench-D + E1 softmacro + fixtures. Train/val/test
  **2471/585/372** (39 labeled cases: 31/4/4); 224 samples use fallback macro
  sizing (no parsed LEF size).
- **Training (2026-05-21, retrained on current dataset):** device=cpu,
  200 epochs, loss 0.30050 → 0.17286.
- **Metrics (test):** mean-L1/core **0.26540**, mae_x/core 0.26475,
  mae_y/core 0.26605, orientation accuracy 0.54301.
- **Outputs:** 24 quarantined `eda.e1_candidate.v1` manifests (inference run),
  17 cases blocked (fixed-only or pre-replay geometry). `release_use_allowed=false`.
- **Claim boundary:** training/inference only; no OpenROAD replay, PPA, signoff,
  or release claim. Any candidate must clear deterministic OpenLane/OpenROAD
  replay + review before promotion.
- **Ceiling (measured):** the test mean-L1/core (0.26540) only marginally edges
  the dependency-free mean-prior (0.27083). A controlled architecture sweep on
  the same splits (64×3 → 256×5 layers, 200–800 epochs) does not improve
  held-out test error — wider/deeper nets match or underperform the small MLP.
  The bottleneck is data volume (39 labeled cases, only 4 held-out test cases)
  and feature poverty (no graph/timing/congestion features), not model capacity.
  Gains are unprovable until E1 has more labeled placement cases and real movable
  macros to replay against; keeping the small MLP is the honest choice at this
  data volume.
