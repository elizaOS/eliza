# RAG-TF Model Changelog

## Version History

---

### v2.1.0 — January 15, 2024

**Release Type:** Minor release with retrieval engine updates

#### Changes

- **Retrieval Engine:**
  - Upgraded embedding model from `traffic-embed-v2` to `traffic-embed-v3` for improved temporal pattern matching
  - Recalibrated retrieval weights for peak scenarios to better align with updated training corpus
  - Increased default retrieval window from 10 to 15 similar days for improved context diversity
  - Added support for holiday-aware retrieval filtering

- **Transformer Decoder:**
  - Replaced sinusoidal positional encoding with rotary positional embeddings (RoPE)
  - Reduced attention head count from 8 to 6 based on ablation study results
  - Added layer normalization before final projection layer

- **Training & Data:**
  - Retrained on expanded dataset covering Q3-Q4 2023 sensor data from 12 additional urban corridors
  - Applied updated loss weighting scheme: MSE weight 0.7, Huber weight 0.3
  - Batch size increased from 64 to 128 for training stability

- **Known Issues:**
  - Slight systematic underprediction bias for high-volume urban sensors during AM peak not yet resolved. Investigation ongoing — likely related to retrieval weight recalibration favoring off-peak pattern diversity. Affects sensors with typical peak flows above 110 veh/5min.
  - Confidence interval coverage may be narrower than nominal 95% for sensors with high flow variance

- **Performance Notes:**
  - Overall MAE improved by 4.2% on validation set (all scenarios combined)
  - Weekend and holiday scenario accuracy improved significantly (+8.1% MAPE reduction)
  - Peak scenario accuracy on suburban sensors improved; urban peak results mixed

---

### v2.0.3 — November 2, 2023

**Release Type:** Patch

#### Changes

- Fixed edge case in retrieval module where duplicate days could be selected when query window overlapped with daylight saving time transitions
- Updated confidence interval calculation to use bootstrap method (1000 iterations)
- Corrected timezone handling for sensors in multi-timezone deployments

---

### v2.0.2 — September 18, 2023

**Release Type:** Patch

#### Changes

- Addressed memory leak in batch inference pipeline affecting deployments with >500 concurrent sensor streams
- Added input validation for flow values exceeding 3σ from historical mean
- Improved logging granularity for retrieval step timing diagnostics

---

### v2.0.1 — August 5, 2023

**Release Type:** Patch

#### Changes

- Fixed numerical precision issue in attention score computation for very long retrieval contexts (>30 days)
- Updated dependency: numpy 1.24.3 → 1.25.2, torch 2.0.0 → 2.0.1
- Added fallback to historical average when retrieval returns fewer than 3 similar days

---

### v2.0.0 — June 12, 2023

**Release Type:** Major release

#### Changes

- **Architecture Overhaul:**
  - Introduced Retrieval-Augmented Generation (RAG) framework combining similarity-based retrieval with transformer decoder
  - Replaced previous LSTM-attention architecture entirely
  - New embedding model `traffic-embed-v2` trained on 3 years of multi-sensor data

- **Retrieval Module:**
  - Cosine similarity-based day selection from historical corpus
  - Configurable retrieval window (default: 10 similar days)
  - Support for scenario-specific retrieval (peak, offpeak, weekend, holiday)

- **Inference Pipeline:**
  - 12-step ahead forecasting at configurable intervals (default: 5 minutes)
  - 95% confidence intervals via quantile regression heads
  - Batch inference support for multi-sensor deployments

- **Validation Results (June 2023):**
  - MAE: 4.8 (all scenarios, 200-sensor test set)
  - RMSE: 6.2
  - MAPE: 3.9%
  - Peak scenario MAE: 5.1
  - Off-peak scenario MAE: 3.2

---

### Pre-v2.0 (Legacy)

Previous versions used an LSTM-attention architecture. See `legacy_changelog.md` for details on versions 1.x.
