# Model cards — supervised macro-placement imitation + PD surrogate

## Supervised macro-placement imitation (dependency-free)

- **Task:** learn macro-key mean normalized placement priors from known
  placements; emit quarantined candidates.
- **Code:** `train_macro_placement_supervised_model.py` /
  `check_macro_placement_supervised_model.py`.
- **Data:** same supervised JSONL splits as the Torch regressor (2340/200/240).
- **Result (2026-05-21):** 18 candidates, 6 blocked; mean-prior model.
- **Claim boundary:** training/inference only; no replay/PPA/release claim.
- **Purpose:** dependency-free baseline that runs anywhere (no torch); a sanity
  floor for the Torch regressor.

## PD surrogate (E1 OpenLane labels)

- **Task:** constant-mean surrogate over normalized `eda.flow_run.v1` labels.
- **Code:** `train_pd_surrogate_smoke.py`.
- **Data (2026-05-21):** **real** E1 OpenLane signoff label from the completed
  `pd-smoke` SKY130 run (`deterministic_run_artifacts_present=True`), not the
  checked-in fixture. 284 raw metrics normalized.
- **Claim boundary:** proves the label → model → eval artifact path; makes no
  generalization, PPA, or signoff claim (single real label point).
- **Next:** many seeded OpenLane runs (varied knobs) for a generalizing
  predictor; pairs with the CircuitNet GNN work.
