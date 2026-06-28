# Model cards — supervised macro-placement imitation + PD surrogate

## Supervised macro-placement imitation (dependency-free)

- **Task:** learn macro-key mean normalized placement priors from known
  placements; emit quarantined candidates.
- **Code:** `train_macro_placement_supervised_model.py` /
  `check_macro_placement_supervised_model.py`.
- **Data:** same supervised JSONL splits as the Torch regressor — now
  2471/585/372 (39 labeled cases: 31 train / 4 val / 4 test; 224 fallback-sized
  samples).
- **Metrics (2026-05-21, retrained on current dataset):** mean-L1/core
  train 0.23099, val 0.25438, **test 0.27083** (mae_x 0.26714, mae_y 0.27453).
  25 candidates emitted, 16 blocked (no movable / pre-replay geometry).
- **Claim boundary:** training/inference only; no replay/PPA/release claim.
- **Purpose:** dependency-free baseline that runs anywhere (no torch). It is the
  honest floor for the Torch regressor — the MLP's held-out test error (0.26540)
  only marginally edges this mean-prior (0.27083), so the learned per-macro
  features add little held-out signal beyond the prior on these splits.

## PD surrogate (E1 OpenLane labels)

- **Task:** constant-mean surrogate over normalized `eda.flow_run.v1` labels,
  with an explicit generalization gate.
- **Code:** `train_pd_surrogate_smoke.py`.
- **Data (2026-05-21):** the script now auto-discovers **every** parsed OpenLane
  flow label under `build/ai_eda/openlane_flow_labels/*/records/` and
  deduplicates by design bundle + signoff-metric content. Across both run-dirs
  this resolves to **1 distinct real signoff point** — design bundle
  `e1_chip_top-sky130A` (`DESIGN_NAME=e1_pd_smoke_top`, sky130A, 284 raw
  metrics, `deterministic_run_artifacts_present=True`). The other local runs are
  byte-identical re-runs / a near-duplicate config of the same design, so they
  collapse to the same label.
- **Generalization gate:** `BLOCKED_INSUFFICIENT_DISTINCT_LABELS` —
  `distinct_label_count=1 < GENERALIZATION_MIN_DISTINCT_LABELS=3`. A constant
  mean over one design has zero held-out signal; generalization is structurally
  impossible until >= 3 independent design/config signoff points exist. The gate
  is recorded in `pd_surrogate_eval.json`/`pd_surrogate_training_run.json` and
  names the seeding command:
  `make ai-eda-openlane-flow-labels` on a new design/config, then re-parse with
  `parse_openlane_metrics_to_flow_run.py`.
- **Claim boundary:** proves the label → model → eval artifact path; the
  plumbing smoke still passes, but makes no generalization, PPA, or signoff
  claim. CircuitNet3 GNN pretraining (separate `train_pd_surrogates.py`) covers
  the multi-design regime on public dataset labels.
