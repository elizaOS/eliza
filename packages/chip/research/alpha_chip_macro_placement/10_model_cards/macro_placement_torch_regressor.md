# Model card — macro-placement PyTorch regressor

- **Task:** predict normalized macro `(x, y)` + orientation per placement case.
- **Code:** `scripts/ai_eda/train_macro_placement_torch_regressor.py` /
  `infer_macro_placement_torch_regressor.py`.
- **Arch:** small MLP regressor (per-macro feature → normalized position +
  orientation logits). Device-agnostic (`--device auto`: cuda/mps/cpu).
- **Data:** `eda.macro_placement` supervised JSONL splits — TILOS
  MacroPlacement + bounded ChiPBench-D + E1 softmacro + fixtures. Train/val/test
  2340/200/240; 224 samples use fallback macro sizing (no parsed LEF size).
- **Training (2026-05-21, this run):** device=cpu, 25 epochs, loss
  0.30094 → 0.22631.
- **Metrics (test):** mean-L1/core 0.26462, mae_x/core 0.26482,
  mae_y/core 0.26443, orientation accuracy 0.45417. (Matches prior MPS run —
  reproducible.)
- **Outputs:** 18 quarantined `eda.e1_candidate.v1` manifests, 6 cases blocked
  (fixed-only or pre-replay geometry). `release_use_allowed=false`.
- **Claim boundary:** training/inference only; no OpenROAD replay, PPA, signoff,
  or release claim. Any candidate must clear deterministic OpenLane/OpenROAD
  replay + review before promotion.
- **Known limits:** tiny model; orientation accuracy near chance on hard cases;
  no graph/timing/congestion features. Gains unprovable until E1 has real
  movable macros to replay against.
