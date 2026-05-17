---
id: task_00061_rag_traffic_forecast_statistical_assessment
name: RAG Traffic Forecast Statistical Assessment
category: Data Analysis and Modeling
subcategory: Statistical Analysis and Modeling
grading_type: hybrid
verification_method: rubric
external_dependency: none
input_modality: text-only
timeout_seconds: 1800
workspace_files:
- source: data/historical_traffic.csv
  dest: data/historical_traffic.csv
- source: data/rag_forecast_output.json
  dest: data/rag_forecast_output.json
- source: data/sensor_metadata.yaml
  dest: data/sensor_metadata.yaml
- source: data/baseline_forecasts.csv
  dest: data/baseline_forecasts.csv
- source: data/model_performance_log.csv
  dest: data/model_performance_log.csv
- source: config/analysis_parameters.json
  dest: config/analysis_parameters.json
- source: data/weather_conditions.csv
  dest: data/weather_conditions.csv
- source: docs/rag_model_changelog.md
  dest: docs/rag_model_changelog.md
- source: data/actual_future_values.csv
  dest: data/actual_future_values.csv
grading_weights:
  automated: 0.3
  llm_judge: 0.7
---
## Prompt

I've got the latest 12-step RAG-TF forecast for sensor S-4021 from this morning's peak window, and I need to put together a proper statistical assessment before passing it to the operations team — they're planning staffing and incident response around these numbers, so we need to actually vet this rather than just forwarding it.

Everything you need is in the workspace — RAG forecast output in `data/rag_forecast_output.json`, actual observed values in `data/actual_future_values.csv`, historical traffic for context, baseline model forecasts in `data/baseline_forecasts.csv`, sensor metadata, weather data, performance logs, and config files. Take a careful look at everything and make sure you understand the data before diving into the numbers.

Here's what I need:
1. A thorough assessment report at `reports/rag_forecast_assessment.md` — how the RAG model stacks up against the baselines on the actuals, whether there's any systematic bias, how the errors evolve across the 12 steps, assessment of the forecast confidence intervals against observed values, and a clear bottom-line recommendation for the ops team on whether they can rely on this forecast or need to adjust or fall back.
2. A structured metrics summary at `reports/metrics_summary.json` so we can pipe the key numbers into our monitoring dashboard.
3. A reproducible Python analysis script at `scripts/analysis.py` that reads the workspace data files, computes all the metrics you report, and prints the key findings to stdout — the ops team wants to be able to re-run this whenever new forecasts come in.

## Expected Behavior

The agent should produce three deliverables: a thorough statistical assessment report at `reports/rag_forecast_assessment.md`, a structured metrics summary at `reports/metrics_summary.json`, and a reproducible Python analysis script at `scripts/analysis.py`. The analysis must correctly handle two embedded traps in the data.

**Trap 1 — Unit Mismatch (config/analysis_parameters.json):**
The configuration file `config/analysis_parameters.json` specifies a `normalization_factor` of 10 and labels the flow unit as `vehicles_per_5min_divided_by_10`, implying the raw data needs to be multiplied by 10. This is incorrect. The raw data in `data/historical_traffic.csv` and `data/actual_future_values.csv` is already in vehicles per 5 minutes. The RAG forecast values in `data/rag_forecast_output.json` are also in the same unit. The agent should recognize that applying the normalization factor would produce nonsensical values (e.g., 1260 vs. 111.3) and should use the raw values directly. The agent should verify all configuration parameters against the actual data rather than trusting them at face value.

**Trap 2 — Outdated Performance Metrics (data/model_performance_log.csv):**
The performance log contains 5 entries for sensor S-4021 under the "peak" scenario from 2023 (February through October) showing excellent performance (MAE ~3.5, MAPE ~2.8%). However, the model changelog (`docs/rag_model_changelog.md`) documents that v2.1 was released in January 2024 with a recalibration that introduced a "known issue: slight systematic underprediction bias for high-volume urban sensors during AM peak." The agent should not cite the 2023 performance metrics as evidence that the RAG model is reliable for this scenario. Instead, it should note that those metrics predate the v2.1 recalibration and that the current model version has a known underprediction issue.

**Correct Analysis:**

1. **Step-by-step comparison table** using actual values [126, 122, 118, 121, 117, 114, 112, 110, 108, 105, 103, 100] vs. RAG forecasts [111.3, 113.5, 109.1, 109.2, 106.0, 103.5, 96.0, 97.6, 98.0, 94.4, 93.0, 90.5] vs. historical average [128.5, 127.0, 125.8, 124.3, 123.1, 121.5, 120.2, 119.0, 117.8, 116.5, 115.2, 114.0] and ARIMA [125.2, 122.8, 120.1, 118.5, 117.0, 115.3, 113.8, 112.0, 110.5, 109.2, 107.8, 106.5] baselines from `data/baseline_forecasts.csv`.

2. **RAG Error Metrics (Ground Truth — manually verified):** The RAG model systematically underpredicts. MAE ≈ 11.16, RMSE ≈ 11.37, MAPE ≈ 9.89%. Every single RAG prediction is below the actual value, confirming systematic negative bias. Step-by-step errors (actual − forecast): [14.7, 8.5, 8.9, 11.8, 11.0, 10.5, 16.0, 12.4, 10.0, 10.6, 10.0, 9.5].

3. **Baseline Comparisons (Ground Truth — manually verified):** Historical average MAE ≈ 8.08, RMSE ≈ 8.75, MAPE ≈ 7.38%. ARIMA MAE ≈ 2.44, RMSE ≈ 3.03, MAPE ≈ 2.26%. Both baselines outperform the RAG model on this window, with ARIMA being the best performer by a wide margin.

4. **Bias Analysis:** The RAG forecast shows consistent underprediction across all 12 steps, with errors ranging from approximately 8.5 to 16.0 vehicles/5min. The underprediction does not strictly worsen with forecast horizon (steps 1–4 avg error: 10.98, steps 5–8: 12.48, steps 9–12: 10.02), but the mean bias of approximately 11.2 vehicles/5min is substantial and aligns with the known v2.1 underprediction issue documented in the changelog. The historical average baseline shows overprediction that worsens with horizon; ARIMA tracks actuals closely at early steps but diverges at later steps.

5. **Confidence Interval Coverage:** The RAG model provides 95% confidence intervals for each step. Of the 12 steps, the actual value falls outside the CI at step 7 (actual 112.0 exceeds CI upper bound 110.3) and step 12 (actual 100.0 barely falls within the CI [76.9, 104.1]). The overall coverage rate of approximately 91.7% (11/12 within CI) is below the nominal 95% level. This is consistent with the known v2.1 issue of narrower-than-nominal CI coverage for high-variance sensors. The systematic underprediction also means the CIs are asymmetrically positioned — actual values tend to fall in the upper portion or above the intervals.

6. **Recommendation:** The RAG forecast should NOT be trusted as-is for this scenario. Either apply a positive bias correction (mean error ≈ +11.2 vehicles/5min) or fall back to the ARIMA baseline which performed substantially better (MAE 2.44 vs. 11.16).

7. **JSON Summary:** The `reports/metrics_summary.json` file should contain structured metrics for all three models (at minimum MAE values), identify the best-performing model (ARIMA), and include a recommendation. Expected structure (flat field names for automated scoring):
```json
{
  "sensor_id": "S-4021",
  "scenario": "peak",
  "rag_mae": 11.16,
  "rag_rmse": 11.37,
  "rag_mape": 9.89,
  "arima_mae": 2.44,
  "arima_rmse": 3.03,
  "arima_mape": 2.26,
  "hist_avg_mae": 8.08,
  "hist_avg_rmse": 8.75,
  "hist_avg_mape": 7.38,
  "best_model": "arima",
  "rag_bias": "systematic_underprediction",
  "mean_bias_vehicles_per_5min": 11.16,
  "recommendation": "Do not trust RAG forecast as-is; fall back to ARIMA or apply +11.2 bias correction"
}
```

8. **Analysis Script:** The `scripts/analysis.py` should be a standalone Python script (minimum ~30 non-blank lines) that reads the workspace data files (`data/actual_future_values.csv`, `data/rag_forecast_output.json`, `data/baseline_forecasts.csv`), computes MAE/RMSE/MAPE for all three models, and prints a formatted comparison summary to stdout. It should use standard library modules (csv, json, math, os) or common packages (numpy, pandas). The output should be consistent with the report and JSON files.

**Multi-level Expected Quality:**

- **Basic completion:** Report file exists with some error metrics and a comparison, mentions RAG underpredicts. JSON file exists with some metrics. No analysis script.
- **Good completion:** Correct metrics for all three models, both traps addressed (avoids normalization, notes outdated performance log), comparison table present, clear recommendation not to trust RAG forecast. JSON contains accurate metrics. Analysis script exists and computes basic metrics.
- **High-quality completion:** All of the above, plus: explicit reasoning for rejecting the normalization factor (demonstrates the absurd values it would produce), cross-references changelog dates against performance log dates to invalidate old metrics, horizon analysis with specific quantitative step-range breakdowns, confidence interval coverage analysis identifying steps where actuals fall outside CIs (step 7: actual 112.0 > CI upper 110.3), quantified bias correction factor, references specific sensor metadata characteristics (urban highway, peak flow range 110–165, inductive loop sensor) to contextualize findings, professional tone appropriate for operations audience, and analysis script is complete and functional. Additionally, a thorough analysis would include: residual pattern diagnostics (checking for autocorrelation or systematic time-dependent trends in forecast errors), statistical hypothesis testing of the observed bias (e.g., t-test with p-value to confirm the underprediction is statistically significant), error distribution characterization (normality, skewness, outlier identification), specific operational thresholds for model switching or alert triggering (e.g., "when MAE exceeds X, deploy ARIMA fallback"), assessment of weather conditions' impact on forecast quality using the provided weather data (noting clear/dry conditions were not a contributing factor), and a quantitative comparison of current performance against the historical performance log data with trend analysis showing performance degradation since v2.1.

The agent should use `data/sensor_metadata.yaml` to confirm this is an urban highway sensor during peak hours (matching the known-issue scenario) and should NOT incorporate weather data as a significant factor (it was a clear, dry day with no precipitation).

## Grading Criteria

- [ ] `report_file_exists`: Report file exists at `reports/rag_forecast_assessment.md` and is non-empty with clear section structure
- [ ] `rag_error_metrics`: Correctly computes RAG forecast error metrics against actuals — at least two of MAE (≈ 11.2), RMSE (≈ 11.4), or MAPE (≈ 9.9%) within reasonable tolerance
- [ ] `baseline_error_metrics`: Correctly computes error metrics for both baseline models against actuals, with Historical Average MAE ≈ 8.1 and ARIMA MAE ≈ 2.4
- [ ] `comparison_table`: Includes a step-by-step comparison table containing correct actual values and RAG forecast values alongside baseline model predictions for all 12 steps
- [ ] `identifies_underprediction`: Identifies the systematic underprediction bias in the RAG forecast with quantitative evidence — full score requires precise bias magnitude (≈11.2 ±1.5), explicit all-12-steps statement, per-step error range bounds (min ~8.5 and max ~16.0), AND identification of the maximum-error and minimum-error step numbers (step 7 = largest ~16.0, step 2 = smallest ~8.5); 0.5 for precise bias with all-steps or error range but missing step extremes; approximate bias or error magnitude scores 0.25; pure keyword mention alone does not score
- [ ] `horizon_error_analysis`: Analyzes error evolution across the 12-step forecast horizon — full score requires all three segment averages (steps 1–4: ~10.98, 5–8: ~12.48, 9–12: ~10.02 within ±1.5) AND identification of steps 5–8 as peak-error segment; 0.75 for ≥2 segment averages (±2.5); must reference concrete step ranges with numerical error values; generic discussion without step-level numbers does not score
- [ ] `avoids_normalization_trap`: Does NOT apply the erroneous normalization_factor of 10 from config/analysis_parameters.json to the raw traffic data
- [ ] `model_version_awareness`: Recognizes that the 2023 performance metrics are outdated post-v2.1 recalibration — full score requires ALL of: citing v2.1, specific 2023 MAE (~3.5) or MAPE (~2.8%) values, v2.1 release date (January 2024), AND explicit invalidation language; 0.5 for v2.1 + invalidation + (metric OR date); v2.1 + bias + (date OR metric) without invalidation scores 0.25; mentioning v2.1 and bias keywords alone does not score
- [ ] `reliability_conclusion`: Concludes that the RAG forecast is unreliable for this scenario AND provides a specific actionable recommendation — full score requires quantified bias correction value (≈+11.2 ±3); partial score requires naming a specific fallback model (ARIMA) with action verb; generic "caution" or "questionable" without named model does not score
- [ ] `identifies_arima_best`: Correctly identifies ARIMA as the best-performing model — full score requires ARIMA MAE (≈2.44) AND explicit MAE difference vs at least one other model (ARIMA vs RAG difference ≈8.7, or ARIMA vs HistAvg difference ≈5.6); 0.5 for claim only (states ARIMA is best without numerical MAE differences); 0.0 for not mentioned
- [ ] `json_summary_valid`: Produces a valid JSON metrics summary at `reports/metrics_summary.json` — full score requires exact field names (`rag_mae`, `rag_rmse`, `rag_mape`, `arima_mae`, `arima_rmse`, `hist_avg_mae`, `recommendation`) with numerical values within ±15% of reference; 0.5 for valid JSON with correct metric values but non-standard field names; models using nested structures (e.g. `models.rag.mae` instead of `rag_mae`) score at most 0.5
- [ ] `analysis_script_valid`: A Python analysis script exists at `scripts/analysis.py` — full score requires ≥30 non-blank lines, data file reads, MAE/RMSE/MAPE computation, relevant imports, AND parameterized paths via argparse/sys.argv/click (making the script reusable); 0.5 for complete script without path parameterization; basic structure without metrics or imports scores lower
- [ ] `confidence_interval_analysis`: Analyzes the RAG forecast confidence intervals against actual observed values — full score requires step 7 breach with exact CI upper bound (110.3), coverage rate quantification, CI asymmetric positioning discussion, AND explicit comparison of upper vs lower bound widths (distance asymmetry from forecast point); 0.5 for CI mention + breach or coverage quantification; CI mention alone scores 0.25
- [ ] `sensor_context_integration`: References specific characteristics from `data/sensor_metadata.yaml` in the analysis — full score requires BOTH peak flow range bounds (110 AND 165), inductive loop sensor type, 3-lane count, model behavior connection, AND explicit discussion of how peak flow range relates to forecast values (e.g. RAG forecasts dropping below typical peak range); 0.5 for peak range + model connection + flow-forecast link but missing sensor type or lanes; 0.25 for ≥2 sensor attributes + model connection; sensor type alone scores 0.1
- [ ] `residual_pattern_analysis`: Report discusses residual patterns in the forecast errors — full score requires explicit residual/error-pattern analysis discussing autocorrelation, serial correlation, or time-dependent structure in errors; 0.5 for mentioning error patterns or residual trends without autocorrelation analysis; 0.0 for no discussion of residual patterns
- [ ] `statistical_significance_test`: Report includes formal statistical significance testing of the observed bias — full score requires naming a specific test method (t-test, Wilcoxon, etc.) AND reporting a p-value or significance level; 0.5 for mentioning "statistically significant" or p-values without a named test; 0.0 for no significance testing
- [ ] `error_distribution_analysis`: Report analyzes error distribution characteristics — full score requires discussing distribution shape (normal/skewed/heavy-tailed) or formal normality testing in error/residual context; 0.5 for mentioning error distribution or outlier analysis without shape characterization; 0.0 for no distribution discussion
- [ ] `operational_threshold_recommendation`: Report provides specific operational thresholds for model management — full score requires ≥1 concrete numerical metric threshold with a corresponding action (e.g. "when MAE > X, switch to ARIMA"); 0.5 for threshold-action recommendations without specific numerical metric values; 0.0 for no operational thresholds
- [ ] `weather_impact_assessment`: Report assesses weather data impact on forecast quality — full score requires referencing weather data (weather_conditions.csv) AND discussing its relevance to the forecast (e.g. "clear/dry conditions suggest weather was not a contributing factor"); 0.0 for no mention of weather impact
- [ ] `historical_context_comparison`: Report compares current forecast performance against historical performance log data — full score requires citing specific historical MAE/MAPE values (~3.5/~2.8%), quantitative comparison with current metrics, AND discussion of performance trend or degradation; 0.5 for mentioning performance log without specific comparative analysis; 0.0 for not referencing historical performance data

## Automated Checks

```python
import os
import re
import json
import csv
import math

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the RAG forecast assessment task."""

    results = {
        "report_file_exists": 0.0,
        "rag_error_metrics": 0.0,
        "baseline_error_metrics": 0.0,
        "comparison_table": 0.0,
        "identifies_underprediction": 0.0,
        "horizon_error_analysis": 0.0,
        "avoids_normalization_trap": 0.0,
        "model_version_awareness": 0.0,
        "reliability_conclusion": 0.0,
        "identifies_arima_best": 0.0,
        "json_summary_valid": 0.0,
        "analysis_script_valid": 0.0,
        "confidence_interval_analysis": 0.0,
        "sensor_context_integration": 0.0,
        "residual_pattern_analysis": 0.0,
        "statistical_significance_test": 0.0,
        "error_distribution_analysis": 0.0,
        "operational_threshold_recommendation": 0.0,
        "weather_impact_assessment": 0.0,
        "historical_context_comparison": 0.0,
    }

    report_path = os.path.join(workspace_path, "reports", "rag_forecast_assessment.md")
    json_path = os.path.join(workspace_path, "reports", "metrics_summary.json")

    if not os.path.isfile(report_path):
        return results

    try:
        with open(report_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return results

    if len(content.strip()) < 100:
        return results

    results["report_file_exists"] = 1.0
    content_lower = content.lower()
    paragraphs = re.split(r'\n\s*\n', content)
    table_rows = re.findall(r'^\|.*\|', content, re.MULTILINE)

    # --- Load reference data from workspace assets ---
    actuals = [126.0, 122.0, 118.0, 121.0, 117.0, 114.0,
               112.0, 110.0, 108.0, 105.0, 103.0, 100.0]
    rag_fc = [111.3, 113.5, 109.1, 109.2, 106.0, 103.5,
              96.0, 97.6, 98.0, 94.4, 93.0, 90.5]
    hist_fc = [128.5, 127.0, 125.8, 124.3, 123.1, 121.5,
               120.2, 119.0, 117.8, 116.5, 115.2, 114.0]
    arima_fc = [125.2, 122.8, 120.1, 118.5, 117.0, 115.3,
                113.8, 112.0, 110.5, 109.2, 107.8, 106.5]

    try:
        with open(os.path.join(workspace_path, "data",
                               "actual_future_values.csv"), "r") as f:
            actuals = [float(r["actual_flow"].strip())
                       for r in csv.DictReader(f)]
    except Exception:
        pass

    try:
        with open(os.path.join(workspace_path, "data",
                               "rag_forecast_output.json"), "r") as f:
            rag_fc = json.load(f)["forecast_values"]
    except Exception:
        pass

    try:
        with open(os.path.join(workspace_path, "data",
                               "baseline_forecasts.csv"), "r") as f:
            rows = list(csv.DictReader(f))
            hist_fc = [float(r["historical_avg_forecast"].strip())
                       for r in rows]
            arima_fc = [float(r["arima_forecast"].strip()) for r in rows]
    except Exception:
        pass

    n = min(len(actuals), len(rag_fc), len(hist_fc), len(arima_fc))

    def calc_mae(act, pred):
        return sum(abs(a - p) for a, p in zip(act[:n], pred[:n])) / n

    def calc_rmse(act, pred):
        return math.sqrt(
            sum((a - p) ** 2 for a, p in zip(act[:n], pred[:n])) / n)

    def calc_mape(act, pred):
        return (sum(abs(a - p) / a
                    for a, p in zip(act[:n], pred[:n])) / n * 100)

    ref_rag_mae = calc_mae(actuals, rag_fc)
    ref_rag_rmse = calc_rmse(actuals, rag_fc)
    ref_rag_mape = calc_mape(actuals, rag_fc)
    ref_hist_mae = calc_mae(actuals, hist_fc)
    ref_arima_mae = calc_mae(actuals, arima_fc)

    # --- rag_error_metrics ---
    # Accept MAE within ±2.5 of computed reference (~11.16)
    mae_ok = rmse_ok = mape_ok = False
    for pat in [r'(?i)mae[^0-9\n]{0,50}(\d+\.?\d*)',
                r'(?i)(\d+\.?\d*)[^0-9\n]{0,20}mae',
                r'(?i)mean\s+absolute\s+error[^0-9\n]{0,50}(\d+\.?\d*)']:
        for m in re.findall(pat, content):
            try:
                if abs(float(m) - ref_rag_mae) <= 2.5:
                    mae_ok = True
            except (ValueError, TypeError):
                continue

    for pat in [r'(?i)rmse[^0-9\n]{0,50}(\d+\.?\d*)',
                r'(?i)(\d+\.?\d*)[^0-9\n]{0,20}rmse',
                r'(?i)root\s+mean\s+square[^0-9\n]{0,50}(\d+\.?\d*)']:
        for m in re.findall(pat, content):
            try:
                if abs(float(m) - ref_rag_rmse) <= 2.5:
                    rmse_ok = True
            except (ValueError, TypeError):
                continue

    for pat in [r'(?i)mape[^0-9\n]{0,50}(\d+\.?\d*)',
                r'(?i)(\d+\.?\d*)[^0-9\n]{0,20}%?\s*mape',
                r'(?i)mean\s+absolute\s+percent[^0-9\n]{0,50}(\d+\.?\d*)']:
        for m in re.findall(pat, content):
            try:
                if abs(float(m) - ref_rag_mape) <= 3.0:
                    mape_ok = True
            except (ValueError, TypeError):
                continue

    for row in table_rows:
        rl = row.lower()
        if 'rag' in rl:
            nums = re.findall(r'(\d+\.?\d+)', row)
            for ns in nums:
                try:
                    v = float(ns)
                    if abs(v - ref_rag_mae) <= 2.5:
                        mae_ok = True
                    if abs(v - ref_rag_rmse) <= 2.5:
                        rmse_ok = True
                    if abs(v - ref_rag_mape) <= 3.0:
                        mape_ok = True
                except (ValueError, TypeError):
                    continue

    metric_hits = sum([mae_ok, rmse_ok, mape_ok])
    if metric_hits >= 2:
        results["rag_error_metrics"] = 1.0
    elif metric_hits >= 1:
        results["rag_error_metrics"] = 0.5

    # --- baseline_error_metrics ---
    # Check values within model-specific context paragraphs or table rows
    hist_ok = False
    arima_ok = False

    for para in paragraphs:
        pl = para.lower()
        if (re.search(r'\b(historical|hist)\b', pl) and
                re.search(r'\b(average|avg|mean)\b', pl)):
            for ns in re.findall(r'(\d+\.?\d+)', para):
                try:
                    if abs(float(ns) - ref_hist_mae) <= 2.5:
                        hist_ok = True
                except (ValueError, TypeError):
                    continue
        if re.search(r'\barima\b', pl):
            for ns in re.findall(r'(\d+\.?\d+)', para):
                try:
                    if abs(float(ns) - ref_arima_mae) <= 1.5:
                        arima_ok = True
                except (ValueError, TypeError):
                    continue

    for row in table_rows:
        rl = row.lower()
        nums = re.findall(r'(\d+\.?\d+)', row)
        if re.search(r'\b(hist|historical)\b', rl):
            for ns in nums:
                try:
                    if abs(float(ns) - ref_hist_mae) <= 2.5:
                        hist_ok = True
                except (ValueError, TypeError):
                    continue
        if 'arima' in rl:
            for ns in nums:
                try:
                    if abs(float(ns) - ref_arima_mae) <= 1.5:
                        arima_ok = True
                except (ValueError, TypeError):
                    continue

    if hist_ok and arima_ok:
        results["baseline_error_metrics"] = 1.0
    elif hist_ok or arima_ok:
        results["baseline_error_metrics"] = 0.5

    # --- comparison_table ---
    # Table must contain actual traffic values AND forecast model values
    actual_strs = [str(int(a)) for a in actuals[:n]]
    rag_strs = ["{:.1f}".format(r) for r in rag_fc[:n]]
    actual_hits = 0
    rag_hits = 0
    for row in table_rows:
        a_hit = any(re.search(r'\b' + v + r'(?:\.0)?(?![.\d])', row)
                    for v in actual_strs)
        r_hit = any(v in row for v in rag_strs)
        if a_hit:
            actual_hits += 1
        if r_hit:
            rag_hits += 1

    if len(table_rows) >= 6 and actual_hits >= 6 and rag_hits >= 4:
        results["comparison_table"] = 1.0
    elif len(table_rows) >= 6 and actual_hits >= 6:
        results["comparison_table"] = 0.75
    elif len(table_rows) >= 3 and actual_hits >= 3:
        results["comparison_table"] = 0.5

    # --- identifies_underprediction ---
    has_keyword = bool(
        re.search(r'\bunder[- ]?predict\w*', content_lower) or
        re.search(r'\bunderestimat\w*', content_lower) or
        re.search(r'\bbelow\s+(the\s+)?actual', content_lower) or
        re.search(r'\bnegative\s+bias', content_lower))

    rag_errors = [a - f for a, f in zip(actuals[:n], rag_fc[:n])]
    mean_bias = sum(rag_errors) / len(rag_errors)
    min_error = min(rag_errors)
    max_error = max(rag_errors)
    has_tight_bias = False
    has_precise_bias = False
    has_approx_bias = False
    for pat in [r'(?i)\bbias\b.{0,50}?(\d+\.?\d*)',
                r'(?i)(\d+\.?\d*).{0,50}?\bbias\b',
                r'(?i)\bmean\s+error\b.{0,50}?(\d+\.?\d*)']:
        for m in re.findall(pat, content):
            try:
                v = float(m)
                if abs(v - mean_bias) <= 1.5:
                    has_tight_bias = True
                if abs(v - mean_bias) <= 2.0:
                    has_precise_bias = True
                if abs(v - mean_bias) <= 4.0:
                    has_approx_bias = True
            except (ValueError, TypeError):
                continue
    has_all_steps = bool(re.search(
        r'(?i)\b(all|every|each)\b.{0,40}'
        r'\b(12|twelve|step|prediction)', content_lower))

    has_error_range = False
    for para in paragraphs:
        if re.search(r'(?m)^\s*\|', para):
            continue
        if re.search(r'(?i)(under|bias|negative|below|error|differ)',
                     para):
            nums = []
            for m in re.findall(r'(\d+\.?\d+)', para):
                try:
                    nums.append(float(m))
                except (ValueError, TypeError):
                    continue
            near_min = any(abs(v - min_error) <= 1.5 for v in nums)
            near_max = any(abs(v - max_error) <= 2.0 for v in nums)
            if near_min and near_max:
                has_error_range = True

    has_error_magnitude = False
    for para in paragraphs:
        if re.search(r'(?m)^\s*\|', para):
            continue
        if re.search(r'(?i)(under|bias|negative|below|error)', para):
            for m in re.findall(r'(\d+\.?\d+)', para):
                try:
                    v = float(m)
                    if 5.0 <= v <= 20.0:
                        has_error_magnitude = True
                except (ValueError, TypeError):
                    continue

    has_bias_with_unit = False
    for pat in [r'(?i)\bbias\b.{0,50}?(\d+\.?\d*)\s*.{0,20}'
                r'(vehicle|veh|per\s+5)',
                r'(?i)(vehicle|veh|per\s+5).{0,30}?(\d+\.?\d*)'
                r'.{0,50}?\bbias\b']:
        for m in re.findall(pat, content):
            for g in m:
                if re.match(r'^\d+\.?\d*$', g):
                    try:
                        if abs(float(g) - mean_bias) <= 2.0:
                            has_bias_with_unit = True
                    except (ValueError, TypeError):
                        continue

    max_err_step = rag_errors.index(max_error) + 1
    min_err_step = rag_errors.index(min_error) + 1
    found_max_step = False
    found_min_step = False
    for para in paragraphs:
        if re.search(r'(?m)^\s*\|', para):
            continue
        if not re.search(r'(?i)(error|bias|under|deviat|differ'
                         r'|larg|small|max|min)', para):
            continue
        if (re.search(r'(?i)step\s*' + str(max_err_step) + r'\b',
                      para) and
                re.search(r'(?i)(max|larg|great|high|worst|peak'
                          r'|biggest)', para)):
            found_max_step = True
        if (re.search(r'(?i)step\s*' + str(min_err_step) + r'\b',
                      para) and
                re.search(r'(?i)(min|small|least|low|narrow'
                          r'|smallest)', para)):
            found_min_step = True
    has_step_extremes = found_max_step and found_min_step

    if (has_keyword and has_tight_bias and has_all_steps
            and has_error_range and has_step_extremes):
        results["identifies_underprediction"] = 1.0
    elif (has_keyword and has_precise_bias
            and (has_all_steps or has_error_range)):
        results["identifies_underprediction"] = 0.5
    elif has_keyword and (has_approx_bias or has_error_magnitude):
        results["identifies_underprediction"] = 0.25

    # --- horizon_error_analysis ---
    horizon_terms = [
        r'(?i)\bhorizon\b.*\b(error|accuracy|degrad)',
        r'(?i)\bstep[s]?\s*\d+.*\b(error|accurac|differ)',
        r'(?i)\b(early|later|first|last)\b.*\bstep',
        r'(?i)\bforecast\b.*\b(degrad|worsen|evolv)',
    ]
    has_heading = bool(re.search(
        r'(?im)^#{1,6}\s+.*(horizon|error.*analy|forecast.*accura'
        r'|step.*analy|temporal)', content))
    has_body = sum(
        1 for p in horizon_terms if re.search(p, content)) >= 1
    has_quant = bool(
        re.search(r'(?i)step\w*\s*\d+\s*[-\u2013to]+\s*\d+',
                  content) or
        re.search(r'(?i)(steps?\s+1|first\s+(four|4)|last\s+(four|4))',
                  content_lower))

    seg_avgs = [(r'(?i)(1\s*[-\u2013]+\s*4|first\s+(four|4))', 10.98),
                (r'(?i)(5\s*[-\u2013]+\s*8|middle)', 12.48),
                (r'(?i)(9\s*[-\u2013]+\s*12|last\s+(four|4))', 10.02)]
    seg_matched = [False, False, False]
    seg_matched_strict = [False, False, False]
    for para in paragraphs:
        for idx, (range_pat, seg_val) in enumerate(seg_avgs):
            if re.search(range_pat, para):
                for m in re.findall(r'(\d+\.\d+)', para):
                    try:
                        v = float(m)
                        if abs(v - seg_val) <= 2.5:
                            seg_matched[idx] = True
                        if abs(v - seg_val) <= 1.5:
                            seg_matched_strict[idx] = True
                    except (ValueError, TypeError):
                        continue
    seg_hits = sum(seg_matched)
    seg_hits_strict = sum(seg_matched_strict)

    has_peak_seg = bool(
        re.search(r'(?i)(5\s*[-\u2013]+\s*8|middle).{0,80}'
                  r'(highest|largest|peak|worst|maximum|great)',
                  content) or
        re.search(r'(?i)(highest|largest|peak|worst|maximum|great)'
                  r'.{0,80}(5\s*[-\u2013]+\s*8|middle)', content))

    has_step_nums = bool(re.search(
        r'(?i)step\s*\d+', content) or re.search(
        r'(?i)\b(horizon|step)\b.{0,30}\d+\.?\d*', content))

    if (has_body and has_quant and seg_hits_strict >= 3
            and has_peak_seg):
        results["horizon_error_analysis"] = 1.0
    elif has_body and has_quant and seg_hits >= 2:
        results["horizon_error_analysis"] = 0.75
    elif has_body and has_quant and has_step_nums:
        results["horizon_error_analysis"] = 0.5
    elif has_body and has_step_nums:
        results["horizon_error_analysis"] = 0.25

    # --- avoids_normalization_trap ---
    norm_vals = [str(int(a * 10)) for a in actuals[:n]]
    hits = sum(1 for v in norm_vals if v in content)
    if hits <= 1:
        results["avoids_normalization_trap"] = 1.0
    elif hits <= 3:
        results["avoids_normalization_trap"] = 0.5

    # --- model_version_awareness ---
    has_v21 = bool(re.search(r'(?i)\bv2\.?1\b', content))
    has_outdated = bool(re.search(
        r'(?i)\b(outdated|stale|obsolete|old|prior)\b'
        r'.{0,60}\b(metric|performance|log)', content))
    has_2023_doubt = bool(re.search(
        r'(?i)\b2023\b.{0,80}\b(no longer|not.{0,20}reflect'
        r'|not.{0,20}reliable|before|pre|outdated)', content))
    has_recalib = bool(re.search(r'(?i)\brecalibrat\w*', content))
    has_bias_term = bool(re.search(
        r'(?i)\b(bias|underpredic|known\s+issue)', content))

    has_2023_metric = False
    for para in paragraphs:
        pl = para.lower()
        if re.search(r'\b2023\b', pl) or re.search(
                r'(?i)(performance\s+log|historical.*metric)', pl):
            nums_with_ctx = re.findall(
                r'(?<![vV])(\d+\.?\d+)', para)
            for m in nums_with_ctx:
                try:
                    v = float(m)
                    if abs(v - 3.5) <= 1.0 or abs(v - 2.8) <= 0.5:
                        has_2023_metric = True
                except (ValueError, TypeError):
                    continue

    has_v21_date = bool(re.search(
        r'(?i)\b(january|jan)\b.{0,10}\b2024\b', content) or
        re.search(r'(?i)\b2024\b.{0,10}\b(january|jan)\b', content) or
        re.search(r'(?i)\b2024[\s\-./]0?1\b', content))

    if (has_v21 and (has_outdated or has_2023_doubt) and
            has_bias_term and has_2023_metric and has_v21_date):
        results["model_version_awareness"] = 1.0
    elif (has_v21 and (has_outdated or has_2023_doubt) and
            has_bias_term and (has_2023_metric or has_v21_date)):
        results["model_version_awareness"] = 0.5
    elif has_v21 and has_bias_term and (has_v21_date or has_2023_metric):
        results["model_version_awareness"] = 0.25

    # --- reliability_conclusion ---
    has_unreliable = bool(
        re.search(r'(?i)\b(not\s+reliable|unreliable|should\s+not'
                  r'\s+.{0,20}trust|cannot\s+.{0,20}trust'
                  r'|not\s+.{0,10}recommended?\s+.{0,20}as.?is)',
                  content))
    has_action = bool(
        re.search(r'(?i)\b(fall\s*back|fallback)\b.{0,40}'
                  r'\b(baseline|arima)', content) or
        re.search(r'(?i)\bbias\s+correct\w*', content) or
        re.search(r'(?i)\brecommend\w*\b.{0,40}'
                  r'\b(arima|baseline|alternative|correction)',
                  content))

    has_correction_value = False
    for pat in [r'(?i)(?:correct\w*|adjust\w*|bias\s+of|offset)'
                r'.{0,50}?(\d+\.?\d+)',
                r'(?i)(\d+\.?\d+).{0,50}?'
                r'(?:correct\w*|adjust\w*|offset|bias\s+factor)',
                r'(?i)\+\s*(\d+\.?\d+)\s*.{0,20}?'
                r'(?:vehicle|veh|per)']:
        for m in re.findall(pat, content):
            try:
                if abs(float(m) - mean_bias) <= 3.0:
                    has_correction_value = True
            except (ValueError, TypeError):
                continue

    has_named_model = bool(re.search(
        r'(?i)\b(arima|historical\s+average)\b', content))

    if has_unreliable and has_action and has_correction_value:
        results["reliability_conclusion"] = 1.0
    elif has_unreliable and has_action:
        results["reliability_conclusion"] = 0.75
    elif has_action:
        results["reliability_conclusion"] = 0.5
    elif has_unreliable and has_named_model:
        results["reliability_conclusion"] = 0.25

    # --- identifies_arima_best ---
    arima_best = any(re.search(p, content) for p in [
        r'(?i)\barima\b.{0,60}\b(best|better|superior|outperform'
        r'|lowest\s+error|most\s+accurate)',
        r'(?i)\b(best|better|superior|outperform|lowest\s+error'
        r'|most\s+accurate)\b.{0,60}\barima\b',
    ])
    arima_num = False
    for pat in [r'(?i)arima.{0,80}?(\d+\.?\d*)',
                r'(?i)(\d+\.?\d*).{0,80}?arima']:
        for m in re.findall(pat, content):
            try:
                if abs(float(m) - ref_arima_mae) <= 2.0:
                    arima_num = True
            except (ValueError, TypeError):
                continue

    arima_diff_rag = ref_rag_mae - ref_arima_mae
    arima_diff_hist = ref_hist_mae - ref_arima_mae
    has_mae_diff = False
    known_metrics = [ref_rag_mae, ref_rag_rmse, ref_rag_mape,
                     ref_hist_mae, ref_arima_mae]
    for para in paragraphs:
        if re.search(r'(?m)^\s*\|', para):
            continue
        if not re.search(r'(?i)\barima\b', para):
            continue
        nums = []
        for m in re.findall(r'(\d+\.?\d+)', para):
            try:
                v = float(m)
                if not any(abs(v - km) <= 0.3 for km in known_metrics):
                    nums.append(v)
            except (ValueError, TypeError):
                continue
        has_compare = bool(re.search(
            r'(?i)(differ\w*|gap|margin|advantage|lower\s+(than|by)'
            r'|better\s+(than|by)|outperform\w*\s+by|compar\w*'
            r'|versus|vs\.?|exceed\w*\s+by|improvement'
            r'|reduction|more\s+than|less\s+than)', para))
        if has_compare:
            if (any(abs(v - arima_diff_rag) <= 1.5 for v in nums) or
                    any(abs(v - arima_diff_hist) <= 1.5
                    for v in nums)):
                has_mae_diff = True
                break
        if (any(abs(v - arima_diff_rag) <= 0.5 for v in nums) or
                any(abs(v - arima_diff_hist) <= 0.5 for v in nums)):
            has_mae_diff = True
            break

    if arima_best and arima_num and has_mae_diff:
        results["identifies_arima_best"] = 1.0
    elif arima_best:
        results["identifies_arima_best"] = 0.5

    # --- json_summary_valid ---
    if os.path.isfile(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                jdata = json.load(f)

            if not isinstance(jdata, dict):
                results["json_summary_valid"] = 0.1
            else:
                ref_arima_rmse = calc_rmse(actuals, arima_fc)
                required_fields = {
                    "rag_mae": ref_rag_mae,
                    "rag_rmse": ref_rag_rmse,
                    "rag_mape": ref_rag_mape,
                    "arima_mae": ref_arima_mae,
                    "arima_rmse": ref_arima_rmse,
                    "hist_avg_mae": ref_hist_mae,
                }

                def find_exact_field(obj, name, depth=0):
                    if depth > 5:
                        return None
                    if isinstance(obj, dict):
                        if name in obj:
                            return obj[name]
                        for v in obj.values():
                            r = find_exact_field(v, name, depth + 1)
                            if r is not None:
                                return r
                    return None

                fields_found = 0
                values_accurate = 0
                for fname, ref_val in required_fields.items():
                    val = find_exact_field(jdata, fname)
                    if val is not None:
                        fields_found += 1
                        try:
                            if abs(float(val) - ref_val) <= ref_val * 0.15:
                                values_accurate += 1
                        except (ValueError, TypeError):
                            pass

                has_rec = isinstance(
                    find_exact_field(jdata, "recommendation"), str)

                if (fields_found >= 6 and values_accurate >= 5
                        and has_rec):
                    results["json_summary_valid"] = 1.0
                elif fields_found >= 4 and values_accurate >= 3:
                    results["json_summary_valid"] = 0.75
                else:
                    jstr = json.dumps(jdata).lower()
                    model_refs = sum(
                        1 for t in ["rag", "arima", "historical",
                                    "baseline", "average"]
                        if t in jstr)
                    has_any_rec = any(t in jstr for t in [
                        "recommend", "conclusion", "fallback", "bias"])

                    def extract_nums(obj, depth=0):
                        if depth > 5:
                            return []
                        nums = []
                        if isinstance(obj, (int, float)):
                            nums.append(float(obj))
                        elif isinstance(obj, dict):
                            for v in obj.values():
                                nums.extend(extract_nums(v, depth + 1))
                        elif isinstance(obj, list):
                            for v in obj:
                                nums.extend(extract_nums(v, depth + 1))
                        return nums

                    all_nums = extract_nums(jdata)
                    num_hits = sum([
                        any(abs(x - ref_rag_mae) <= 2.5
                            for x in all_nums),
                        any(abs(x - ref_arima_mae) <= 1.5
                            for x in all_nums),
                        any(abs(x - ref_hist_mae) <= 2.5
                            for x in all_nums),
                    ])
                    if (model_refs >= 2 and num_hits >= 2
                            and has_any_rec):
                        results["json_summary_valid"] = 0.5
                    elif model_refs >= 2 and num_hits >= 1:
                        results["json_summary_valid"] = 0.35
                    elif model_refs >= 1:
                        results["json_summary_valid"] = 0.2
                    else:
                        results["json_summary_valid"] = 0.1
        except (json.JSONDecodeError, Exception):
            results["json_summary_valid"] = 0.0

    # --- analysis_script_valid ---
    script_path = os.path.join(workspace_path, "scripts", "analysis.py")
    if os.path.isfile(script_path):
        try:
            with open(script_path, "r", encoding="utf-8") as f:
                script_content = f.read()
            script_lines = [l for l in script_content.strip().split('\n')
                            if l.strip()]
            if len(script_lines) >= 30:
                has_data = sum(1 for p in [
                    'actual_future_values', 'rag_forecast_output',
                    'baseline_forecasts', 'historical_traffic',
                    'sensor_metadata', 'model_performance_log'
                ] if p in script_content) >= 1
                has_metrics = sum(1 for kw in [
                    'mae', 'rmse', 'mape', 'mean_absolute',
                    'root_mean', 'mean_squared'
                ] if kw in script_content.lower()) >= 2
                has_imports = sum(1 for kw in [
                    'import csv', 'import json', 'import os',
                    'import math', 'import numpy', 'import pandas'
                ] if kw in script_content) >= 2
                has_parameterized = bool(
                    re.search(r'(?:import\s+argparse|'
                              r'from\s+argparse)', script_content) or
                    'sys.argv' in script_content or
                    re.search(r'(?:import\s+click|from\s+click)',
                              script_content))

                if (has_data and has_metrics and has_imports
                        and has_parameterized):
                    results["analysis_script_valid"] = 1.0
                elif has_data and has_metrics and has_imports:
                    results["analysis_script_valid"] = 0.5
                elif has_data and (has_metrics or has_imports):
                    results["analysis_script_valid"] = 0.35
                else:
                    results["analysis_script_valid"] = 0.2
            elif len(script_lines) >= 10:
                results["analysis_script_valid"] = 0.15
        except Exception:
            pass

    # --- confidence_interval_analysis ---
    ci_terms = [
        r'(?i)\bconfidence\s+interval',
        r'(?i)\b(CI|C\.I\.)\b',
        r'(?i)\bcoverage\b.*\b(interval|confidence|nominal)',
    ]
    has_ci_mention = sum(
        1 for p in ci_terms if re.search(p, content)) >= 1
    has_step7_with_bound = bool(
        re.search(r'(?i)(step\s*7|seventh\s+step)', content) and
        re.search(r'110\.3', content))
    has_ci_breach = bool(
        re.search(r'(?i)(step\s*7|seventh\s+step)', content) and
        re.search(r'(?i)(outside|exceed|above|beyond|breach|violat)',
                  content)
    ) or bool(re.search(r'110\.3', content))
    has_ci_quant = bool(
        re.search(r'(?i)(coverage|within).{0,40}(\d+\.?\d*)\s*%',
                  content) or
        re.search(r'(?i)\d+\s*(?:of|out\s+of|/)\s*12', content))
    has_ci_asymmetry = bool(
        re.search(r'(?i)\b(asymmetr\w*|skew\w*|shifted|off[- ]?center'
                  r'|systematic\w*\s+.{0,30}(CI|interval|bound))',
                  content) and has_ci_mention) or bool(
        re.search(r'(?i)(upper\s+portion|upper\s+end|upper\s+half'
                  r'|upper\s+bound).{0,60}(actual|observed)',
                  content) or
        re.search(r'(?i)(actual|observed).{0,60}'
                  r'(upper\s+portion|upper\s+end|upper\s+half)',
                  content))

    has_ci_bound_width = False
    has_both_bounds = (
        bool(re.search(r'(?i)\bupper\s+(bound|limit|band)\b',
                       content)) and
        bool(re.search(r'(?i)\blower\s+(bound|limit|band)\b',
                       content)))
    if has_both_bounds and has_ci_mention:
        for para in paragraphs:
            if not re.search(r'(?i)\b(CI|confidence|interval'
                             r'|bound|limit|band)\b', para):
                continue
            if (re.search(r'(?i)(width|wider|narrower|distance'
                          r'|asymmetr|unequal|differ|ratio|spread)',
                          para) and
                    (re.search(r'(?i)upper', para) or
                     re.search(r'(?i)lower', para))):
                has_ci_bound_width = True
                break

    if (has_ci_mention and has_step7_with_bound and
            has_ci_quant and has_ci_asymmetry
            and has_ci_bound_width):
        results["confidence_interval_analysis"] = 1.0
    elif has_ci_mention and (has_ci_breach or has_ci_quant):
        results["confidence_interval_analysis"] = 0.5
    elif has_ci_mention:
        results["confidence_interval_analysis"] = 0.25

    # --- sensor_context_integration ---
    has_road_type = bool(
        re.search(r'(?i)\b(urban\s+highway|highway\s+7)\b', content))
    has_peak_range_both = False
    for para in paragraphs:
        if (re.search(r'\b110\b', para) and
                re.search(r'\b165\b', para) and
                re.search(r'(?i)\b(vehicle|veh|flow|range|peak'
                          r'|typical|capacity)\b', para)):
            has_peak_range_both = True
            break
    has_peak_range = bool(
        re.search(r'(?i)\b(110|165)\b.{0,40}\b(vehicle|veh|flow|range)',
                  content) or
        re.search(r'(?i)(typical|expected).{0,40}\bpeak\b.{0,40}'
                  r'\b(flow|volume|range)', content))
    has_sensor_type = bool(
        re.search(r'(?i)\binductive\s+loop\b', content))
    has_lanes = bool(re.search(r'(?i)\b3[\s-]*(lanes?|lns?)\b', content))

    sensor_hits = sum([has_road_type, has_peak_range,
                       has_sensor_type, has_lanes])

    has_model_connection = False
    for para in paragraphs:
        has_sensor_ref = bool(re.search(
            r'(?i)\b(urban\s+highway|highway\s+\d|inductive\s+loop'
            r'|peak\s+flow\s+range|high.?volume\s+sensor)', para))
        has_model_ref = bool(re.search(
            r'(?i)\b(rag\b|forecast|model\b|bias\b|underpredic'
            r'|known\s+issue)', para))
        if has_sensor_ref and has_model_ref:
            has_model_connection = True
            break

    has_numerical_sensor = has_lanes or bool(
        re.search(r'(?i)\b(110|165)\b.{0,40}'
                  r'\b(vehicle|veh|flow|range)', content))

    has_flow_forecast_link = False
    for para in paragraphs:
        has_peak_num = bool(
            re.search(r'\b(110|165)\b', para) and
            re.search(r'(?i)(peak|range|typical|flow|volume)',
                      para))
        has_fc_compare = bool(re.search(
            r'(?i)(forecast|predict|rag|model).{0,60}'
            r'(below|under|outside|lower|drop|within|above|'
            r'exceed|beyond)', para) or re.search(
            r'(?i)(below|under|outside|lower|drop|within|above|'
            r'exceed|beyond).{0,60}'
            r'(forecast|predict|rag|range)', para))
        if has_peak_num and has_fc_compare:
            has_flow_forecast_link = True
            break

    if (has_peak_range_both and has_sensor_type and has_lanes
            and has_flow_forecast_link and has_model_connection):
        results["sensor_context_integration"] = 1.0
    elif (has_peak_range_both and has_model_connection
            and has_flow_forecast_link):
        results["sensor_context_integration"] = 0.5
    elif sensor_hits >= 2 and has_model_connection:
        results["sensor_context_integration"] = 0.25
    elif sensor_hits >= 1:
        results["sensor_context_integration"] = 0.1

    # --- residual_pattern_analysis ---
    has_residual_kw = bool(
        re.search(r'(?i)\bresidual\w*\b', content))
    has_error_pattern = bool(
        re.search(r'(?i)\berror\s+pattern', content) or
        re.search(r'(?i)\bpattern\b.{0,30}\b(error|residual)\b',
                  content))
    has_autocorrelation = bool(
        re.search(r'(?i)\b(auto[- ]?correlat\w*|serial\s+correlat\w*'
                  r'|durbin[- ]?watson)\b', content))
    has_error_trend_diag = bool(
        re.search(r'(?i)\b(error|residual)\b.{0,50}'
                  r'\b(trend|time[- ]?dependent|non[- ]?random'
                  r'|structured|systematic\s+pattern)\b',
                  content))

    if ((has_residual_kw or has_error_pattern)
            and (has_autocorrelation or has_error_trend_diag)):
        results["residual_pattern_analysis"] = 1.0
    elif has_error_pattern or (has_residual_kw and has_error_trend_diag):
        results["residual_pattern_analysis"] = 0.5

    # --- statistical_significance_test ---
    has_specific_test = bool(
        re.search(r'(?i)\b(t[- ]?test|wilcoxon|mann[- ]?whitney'
                  r'|paired\s+t|sign\s+test|chi[- ]?square'
                  r'|anova|f[- ]?test|z[- ]?test)\b', content))
    has_pvalue = bool(
        re.search(r'(?i)\bp[- ]?value\b', content) or
        re.search(r'(?i)\bp\s*[<>=]\s*0?\.\d+', content) or
        re.search(r'(?i)\bsignificance\s+level\b', content) or
        re.search(r'(?i)\b(alpha|α)\s*=\s*0?\.\d+', content))
    has_sig_keyword = bool(
        re.search(r'(?i)\bstatistic\w*\s+significan', content))

    if has_specific_test and (has_pvalue or has_sig_keyword):
        results["statistical_significance_test"] = 1.0
    elif has_sig_keyword or has_pvalue:
        results["statistical_significance_test"] = 0.5

    # --- error_distribution_analysis ---
    has_dist_context = bool(
        re.search(r'(?i)\bdistribut\w*\b.{0,40}'
                  r'\b(error|residual|bias)\b', content) or
        re.search(r'(?i)\b(error|residual|bias)\b.{0,40}'
                  r'\bdistribut\w*\b', content))
    has_dist_shape = bool(
        re.search(r'(?i)\b(normal\w*|gaussian|skew\w*|kurtos\w*'
                  r'|heavy[- ]?tail\w*|leptokurt\w*|platykurt\w*'
                  r'|shapiro|jarque[- ]?bera|kolmogorov'
                  r'|anderson[- ]?darling)\b', content)
        and re.search(r'(?i)\b(error|residual|distribut)\b', content))
    has_outlier_analysis = bool(
        re.search(r'(?i)\boutlier\w*\b.{0,60}'
                  r'\b(error|residual|predict|forecast)\b', content)
        or re.search(r'(?i)\b(error|residual|predict|forecast)\b'
                     r'.{0,60}\boutlier\w*\b', content))

    if has_dist_context and has_dist_shape:
        results["error_distribution_analysis"] = 1.0
    elif has_dist_context or has_outlier_analysis:
        results["error_distribution_analysis"] = 0.5

    # --- operational_threshold_recommendation ---
    has_threshold_with_action = False
    for para in paragraphs:
        has_thresh_kw = bool(re.search(
            r'(?i)\b(threshold|trigger|alert|cutoff)\b', para))
        has_action_verb = bool(re.search(
            r'(?i)\b(switch\w*|fall\s*back|trigger\w*|alert\w*'
            r'|escalat\w*|re-?evaluat\w*|recalibrat\w*'
            r'|deploy\w*|activat\w*)\b', para))
        has_metric_num = bool(re.search(
            r'(?i)(mae|mape|error|bias|rmse)\s*'
            r'[><=]+\s*\d+\.?\d*', para) or re.search(
            r'(?i)\d+\.?\d*\s*.{0,15}'
            r'(mae|mape|error|bias|rmse)', para))
        if has_thresh_kw and has_action_verb and has_metric_num:
            has_threshold_with_action = True
            break

    has_generic_threshold = bool(
        re.search(r'(?i)\b(threshold|trigger|cutoff)\b.{0,80}'
                  r'\b(switch|fall\s*back|alert|escalat'
                  r'|re-?evaluat)\b', content) or
        re.search(r'(?i)\bwhen\b.{0,40}(mae|mape|error|bias)'
                  r'.{0,40}(switch|fall\s*back|alert)', content))

    if has_threshold_with_action:
        results["operational_threshold_recommendation"] = 1.0
    elif has_generic_threshold:
        results["operational_threshold_recommendation"] = 0.5

    # --- weather_impact_assessment ---
    has_weather_data_ref = bool(
        re.search(r'(?i)weather_conditions', content) or
        re.search(r'(?i)\bweather\b.{0,40}'
                  r'(data|csv|file|condition|record)', content))
    has_weather_impact_disc = bool(
        re.search(r'(?i)\bweather\b.{0,80}'
                  r'(impact|affect|influenc|factor|contribut'
                  r'|negligible|minimal|irrelevant'
                  r'|not\s+a\s+factor|no\s+.{0,10}effect)',
                  content) or
        re.search(r'(?i)(precipitation|rainfall).{0,60}'
                  r'(zero|none|0\.0|no\s|absent)', content))

    if has_weather_data_ref and has_weather_impact_disc:
        results["weather_impact_assessment"] = 1.0

    # --- historical_context_comparison ---
    has_perf_log_ref = bool(
        re.search(r'(?i)\b(performance\s+log|model_performance_log'
                  r'|historical\s+performance'
                  r'|past\s+performance)\b', content))

    has_hist_metric_val = False
    for para in paragraphs:
        if not re.search(r'(?i)(performance\s+log|historical\s+'
                         r'(performance|metric)|past\s+(performance'
                         r'|metric)|previous\w*\s+.{0,20}metric'
                         r'|\b2023\b)', para):
            continue
        for m in re.findall(r'(?<![vV])(\d+\.?\d+)', para):
            try:
                v = float(m)
                if abs(v - 3.5) <= 1.5 or abs(v - 2.8) <= 1.0:
                    has_hist_metric_val = True
            except (ValueError, TypeError):
                continue

    has_quant_comparison = False
    for para in paragraphs:
        if not re.search(r'(?i)(historical|past|previous|2023'
                         r'|performance\s+log)', para):
            continue
        has_compare = bool(re.search(
            r'(?i)(compar\w*|contrast|versus|vs\.?|deteriorat\w*'
            r'|degrad\w*|worsen\w*|improv\w*|increas\w*|decreas\w*'
            r'|change\w*|differ\w*|gap|shift\w*|times?\s+'
            r'(higher|greater|worse|lower))', para))
        has_current = bool(re.search(
            r'(?i)(current|now|today|this|present|latest)', para))
        if has_compare and (has_current or has_hist_metric_val):
            has_quant_comparison = True
            break

    has_trend_disc = bool(
        re.search(r'(?i)(trend|trajectory|evolution|degradation'
                  r'|regression|deteriorat)\b.{0,60}'
                  r'(performance|mae|mape|error|accuracy)',
                  content) and
        re.search(r'(?i)(historical|past|previous|2023)', content))

    if (has_hist_metric_val and has_quant_comparison
            and has_trend_disc):
        results["historical_context_comparison"] = 1.0
    elif has_perf_log_ref and (has_hist_metric_val
                               or has_quant_comparison):
        results["historical_context_comparison"] = 0.5

    return results
```

## LLM Judge Rubric

**Fallback Rule:** If the output file `reports/rag_forecast_assessment.md` does not exist or is empty, all criteria below should be scored **0.0**. The absence of `reports/metrics_summary.json` should reduce scores for Criterion 3 but does not trigger the fallback rule.

### Criterion 1: Trap Detection and Resolution Quality (Weight: 25%)

**Human Reference Baseline:** An excellent human analyst would: (1) immediately cross-check the normalization factor against raw data magnitudes, demonstrate the absurd 10x values, and document the rejection reasoning; (2) systematically audit all reference data by checking dates against the changelog, explicitly tabulate which performance log entries predate vs. postdate v2.1, and flag the 2023 metrics as invalidated with specific date evidence.

**Score 1.0**: Meets or exceeds human reference baseline. The report explicitly identifies both traps with clear, well-reasoned explanations demonstrating independent discovery. For the unit mismatch trap, the agent shows it investigated the normalization factor from `config/analysis_parameters.json`, demonstrates the absurd values it would produce (e.g., multiplying actuals by 10 yields ~1260 vs. forecast ~111.3), and justifies using raw values — without relying on any explicit prompt warning about config reliability. For the outdated performance log trap, the agent independently discovers the model changelog (not mentioned in the prompt), explicitly cross-references the 2023 performance log dates against the v2.1 release date (January 2024), identifies that the recalibration postdates the logged metrics, and warns that the 2023 numbers cannot be trusted due to the known underprediction bias. The reasoning chain must be explicit and complete — a generic answer that happens to compute correct metrics without acknowledging the normalization trap, or that correctly computes errors without cross-referencing specific dates, cannot score 1.0.
**Score 0.5**: The agent correctly handles one trap with good reasoning but misses the other entirely or handles it incorrectly. Alternatively, both traps are addressed but with weak or partially incorrect reasoning — for example, uses raw values without explicitly demonstrating why normalization would fail, or notes the changelog bias without connecting specific dates to invalidate the 2023 metrics.
**Score 0.0**: The agent blindly applies the normalization factor and/or uncritically cites outdated performance metrics as evidence of reliability, showing no awareness of either trap.

### Criterion 2: Analytical Depth and Statistical Rigor (Weight: 25%)

**Human Reference Baseline:** An excellent human analyst would: (1) provide a complete 12-step comparison table with error decomposition per step; (2) compute bias correction coefficients with derivation process (mean bias ≈ +11.2, per-step corrections); (3) build a model selection recommendation matrix based on error analysis (RAG vs. ARIMA vs. Historical Average across different metrics); (4) provide segmented reliability assessment by forecast horizon (steps 1–4 vs. 5–8 vs. 9–12 with specific average errors ~10.98, ~12.48, ~10.02 for each segment).

**Score 1.0**: Meets or exceeds human reference baseline. Error metrics for all three models are computed and fall within 20% of ground truth. The step-by-step comparison table is complete with meaningful commentary. The horizon analysis includes specific quantitative step-range breakdowns with numeric average errors per segment. Confidence interval coverage is analyzed with step-level breach identification (step 7: actual 112.0 > CI upper 110.3). Sensor metadata is used to contextualize findings. Baseline comparisons discuss not just rankings but causal reasoning (e.g., ARIMA tracks the downward trend while historical average overshoots due to stationarity assumption).
**Score 0.5**: The report includes required metrics and comparisons but the analysis is largely mechanical — numbers reported without meaningful interpretation, no CI coverage assessment, sensor metadata not referenced, or no per-segment horizon error quantification.
**Score 0.0**: The statistical analysis is fundamentally flawed, missing, or largely hallucinated with numbers that don't correspond to the actual data in the assets files.

### Criterion 3: Recommendation Quality and Deliverable Completeness (Weight: 20%)

**Score 1.0**: The final recommendation is specific, actionable, and well-grounded. It provides a quantified bias correction factor derived from analysis (mean bias ≈ +11.2 vehicles/5min), explicitly names ARIMA as the recommended fallback with its MAE, and addresses operational implications for staffing and incident response. JSON summary exists with correct metrics for all three models. Analysis script exists, reads workspace data, and computes metrics. Report is professionally written.
**Score 0.5**: Recommendation is present and generally reasonable but vague (e.g., "use with caution" without quantifying correction or naming specific fallback). JSON may be missing or have errors. No analysis script.
**Score 0.0**: No clear recommendation, or recommendation contradicts the analysis. No JSON deliverable produced.

### Criterion 4: Operational Decision Support Depth (Weight: 15%)

This criterion evaluates whether the analysis goes beyond academic statistics to provide actionable operational intelligence that the operations team can directly use for staffing and incident-response planning — the kind of depth a skilled analyst would naturally provide even without being explicitly asked.

**Human Reference Baseline:** An excellent human analyst would: (1) specify concrete conditions under which the RAG forecast could still be trusted (e.g., off-peak scenarios, sensors with different characteristics); (2) provide a decision framework for when to switch to ARIMA fallback vs. apply bias correction; (3) quantify the operational impact of the underprediction (e.g., understaffing risk from underestimating traffic by ~11 vehicles/5min).

**Score 1.0**: The report provides specific operational decision guidance beyond the basic "don't trust RAG" conclusion. It includes at least two of: (a) concrete conditions or thresholds for when to apply bias correction vs. fall back to ARIMA, (b) quantified operational impact of the forecast errors on staffing/incident planning, (c) specific guidance on how to use the corrected forecast (e.g., apply +11.2 correction then re-evaluate CI coverage), (d) recommendations for when/how to re-evaluate RAG model performance (e.g., after next recalibration, with what validation protocol).
**Score 0.5**: The report provides a clear recommendation but treats it as a binary "use/don't use" decision without exploring the nuances of operational application or providing conditional guidance.
**Score 0.0**: No operationally relevant guidance beyond generic conclusions, or the recommendation is disconnected from the operational context described in the prompt.

### Criterion 5: Data Limitations Awareness and Methodological Rigor (Weight: 15%)

This criterion evaluates the analyst's self-awareness about the limitations of their own analysis — a hallmark of rigorous analytical practice that distinguishes expert work from superficial reporting.

**Human Reference Baseline:** An excellent human analyst would: (1) discuss sample size limitations (single morning peak window, 12 steps — not statistically robust for generalizing model performance); (2) acknowledge seasonality and temporal factors (one snapshot may not represent typical peak behavior); (3) discuss sensor-specific measurement characteristics that affect data quality (inductive loop measurement properties, lane coverage); (4) interpret confidence intervals in operational terms rather than just reporting coverage percentages (e.g., what 91.7% coverage means for planning decisions).

**Score 1.0**: The report includes substantive discussion of at least two of: (a) sample size / single-window limitations and what this means for the reliability of the computed metrics themselves, (b) seasonality or temporal representativeness concerns, (c) sensor-specific measurement characteristics that affect data quality or generalizability, (d) operational interpretation of confidence intervals (e.g., what 91.7% coverage means for planning decisions vs. just noting it's below 95%). The discussion must be specific and tied to the data, not generic caveats.
**Score 0.5**: The report mentions one limitation or includes generic caveats about data quality without tying them specifically to the current analysis context.
**Score 0.0**: No discussion of data limitations or methodological caveats. The analysis presents results as definitive without any qualification.
