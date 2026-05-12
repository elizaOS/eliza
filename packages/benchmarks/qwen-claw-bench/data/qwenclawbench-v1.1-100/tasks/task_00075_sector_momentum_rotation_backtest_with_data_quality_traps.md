---
id: task_00075_sector_momentum_rotation_backtest_with_data_quality_traps
name: Sector Momentum Rotation Backtest with Data Quality Traps
category: Finance and Quantitative Trading
subcategory: Trading Strategy and Backtesting
grading_type: hybrid
grading_weights:
  automated: 0.75
  llm_judge: 0.25
verification_method: rubric
timeout_seconds: 1800
input_modality: text
external_dependency: false
workspace_files:
- source: data/sector_prices.csv
  dest: data/sector_prices.csv
- source: data/benchmark.csv
  dest: data/benchmark.csv
- source: data/sector_metadata.csv
  dest: data/sector_metadata.csv
- source: data/macro_indicators.json
  dest: data/macro_indicators.json
- source: data/factor_scores.json
  dest: data/factor_scores.json
- source: config/strategy_params.yaml
  dest: config/strategy_params.yaml
- source: config/transaction_costs.json
  dest: config/transaction_costs.json
- source: reference/strategy_notes.md
  dest: reference/strategy_notes.md
---

## Prompt

I've set up a workspace with weekly OHLCV data for six sector ETFs — XLK, XLF, XLE, XLV, XLI, and XLY — covering about 30 weeks from early January through late July 2024. The prices are in `data/sector_prices.csv` and there's a SPY benchmark in `data/benchmark.csv`. I also have a strategy configuration in `config/strategy_params.yaml` that defines the momentum parameters and portfolio construction rules, plus a transaction cost schedule in `config/transaction_costs.json`.

There's a `reference/strategy_notes.md` with some implementation details and override rules you should read before starting — it covers how to handle data quality issues and some risk controls that aren't in the main config. Also check `data/sector_metadata.csv` for any corporate action info that might affect the price data.

What I need: run a full momentum-based sector rotation backtest using this data. The strategy picks the top sectors by momentum score every few weeks, rebalances into them with equal weighting, and tracks performance over the period. The config has all the formula details — lookback window, rebalancing frequency, number of sectors to hold, etc.

Before computing anything, make sure the price data is clean. I know there might be some issues in there — missing data points, possible duplicates, maybe corporate actions that need adjustment. The strategy notes describe how to handle each case. Getting the data preprocessing right is critical because everything downstream depends on it.

Once the backtest is done, I need three things:

First, write up the full analysis in `backtest_report.md` — cover the data cleaning steps you took, the momentum scores and portfolio selections at each rebalancing point, period-by-period and cumulative returns, key performance metrics (total return, annualized return, Sharpe ratio, max drawdown), how the strategy compares to SPY, and what the transaction costs look like. Show your work on the calculations.

Second, dump the structured results into `backtest_results.json` — I need the period-by-period breakdown (which sectors were selected, what the returns were), the overall performance metrics, and the transaction cost summary. Keep the schema clean so I can pipe it into our analytics dashboard.

Third, write a self-contained Python script `backtest.py` that reproduces the entire backtest from the raw data files. It should handle the data cleaning, run the strategy, and print the key results. Use only standard library plus csv/json/math — no pandas or numpy dependency, since I want it portable.

## Expected Behavior

The agent should produce a comprehensive momentum backtest with three deliverables. The critical challenge lies in data preprocessing — three distinct data quality issues must be resolved before any calculations, and a hidden portfolio construction rule in the strategy notes must be discovered and applied.

**1. Data Cleaning — Stock Split Adjustment (XLK):**
- The `data/sector_metadata.csv` file records that XLK had a 2:1 stock split effective 2024-05-24, which falls between week 20 (2024-05-17) and week 21 (2024-05-24) in the price data.
- In `sector_prices.csv`, XLK prices are ~$200–226 for weeks 1–20, then drop to ~$113–120 for weeks 21–30. This is the split, not a crash.
- The agent should divide all pre-split XLK close prices by 2 (or multiply post-split by 2) to create a consistent adjusted series. Adjusted XLK week 1 ≈ $100.25, week 20 ≈ $113.20, week 21 = $113.80.
- **Failure mode**: Without split adjustment, XLK shows a ~46% "crash" at week 21, causing momentum scores from period 2 onward to be wildly wrong (XLK 12-week momentum at week 22 = –46.5% instead of the correct +6.95%).

**2. Data Cleaning — Duplicate Row (XLF):**
- Week 12 (2024-03-22) has two entries for XLF with different close prices: $40.80 (first/correct) and $41.30 (duplicate/wrong).
- Per the strategy notes ("keep the first occurrence and discard later duplicates"), the agent should use $40.80.
- Using the wrong close ($41.30) shifts XLF momentum scores by ~1.2% and can change period rankings.

**3. Data Cleaning — Missing Data (XLE):**
- XLE has no price data for weeks 15, 16, and 17 (2024-04-12 through 2024-04-26).
- Per `strategy_params.yaml` (`missing_data.method: linear_interpolation`) and the strategy notes, these should be linearly interpolated between week 14 ($89.10) and week 18 ($91.20).
- Interpolated values: week 15 = $89.625, week 16 = $90.15, week 17 = $90.675.

**4. Momentum Calculation:**
- Formula from config: `score = close[t - skip_recent] / close[t - skip_recent - lookback] - 1` where lookback=12, skip_recent=1.
- At rebalance week t: end = week (t-1), start = week (t-13). Score = close[end] / close[start] – 1.
- Rebalancing at weeks 14, 18, 22, 26 (every 4 weeks starting at week 14).

**5. Momentum Scores and Rankings (Ground Truth):**

| Rebalance | XLK | XLF | XLE | XLV | XLI | XLY |
|-----------|------|------|------|------|------|------|
| Week 14 | 8.98% | 7.72% | 5.95% | –2.67% | 3.69% | 0.23% |
| Week 18 | 8.37% | 8.68% | 8.59% | –1.78% | 3.35% | 0.58% |
| Week 22 | 6.95% | 8.35% | 3.29% | –3.27% | 2.98% | 1.10% |
| Week 26 | 6.45% | 8.14% | 6.99% | –2.89% | 3.02% | 1.16% |

**6. Hidden Rule — 4-Week Momentum Exclusion:**
- The `reference/strategy_notes.md` states: "any sector showing negative 4-week momentum at the rebalancing date must be excluded from selection, regardless of its 12-week score."
- At week 22, XLE has positive 12-week momentum (+3.29%) but **negative 4-week momentum (–3.06%)**. Per the rule, XLE must be excluded and replaced by the next eligible sector (XLI at +2.98%).
- This changes the period 3 portfolio from [XLF, XLK, XLE] to **[XLF, XLK, XLI]**.

**7. Portfolio Selections and Period Returns:**

| Period | Weeks | Selected Sectors | Period Return |
|--------|-------|------------------|---------------|
| 1 | 14–17 | XLK, XLF, XLE | +3.08% |
| 2 | 18–21 | XLF, XLE, XLK | +0.40% |
| 3 | 22–25 | XLF, XLK, XLI | +2.03% |
| 4 | 26–30 | XLF, XLE, XLK | +3.60% |

**8. Performance Metrics (Ground Truth):**
- Total cumulative return: **9.40%**
- Annualized return: ~27.58% (extrapolated from 17-week period)
- Annualized volatility: ~3.36%
- Sharpe ratio: ~6.72 (inflated due to short backtest period — agent should note this caveat)
- Maximum drawdown: ~0.19%
- SPY benchmark return over same period: **3.67%**
- Strategy excess return: ~5.73 percentage points

**9. Transaction Cost Analysis:**
- Period 1: 3 buys from cash → $329.85 (commission $29.85 + spread $300.00)
- Period 2: No trades (same sectors held) → $0
- Period 3: Sell XLE, buy XLI → $261.31 (2 trades)
- Period 4: Sell XLI, buy XLE → $266.16 (2 trades)
- Total costs: **$857.32** (0.086% of initial $1M capital)
- Return after costs: ~9.31%

**10. Deliverables Quality:**
- `backtest_report.md`: Structured analysis covering all steps, with specific numbers from the data. The agent should show the actual momentum scores, not just state rankings.
- `backtest_results.json`: Valid JSON with performance metrics, period-by-period data, and transaction costs.
- `backtest.py`: Self-contained script using standard library only. Should read the CSV/YAML/JSON config files, perform data cleaning, run the backtest, and print key results. Must handle the split, duplicates, and missing data programmatically.

## Grading Criteria

- [ ] `report_file_exists` — File `backtest_report.md` exists, is non-empty (≥500 characters), and contains structured sections covering data preprocessing, momentum analysis, performance metrics, and benchmark comparison
- [ ] `split_adjustment_handled` — Report explicitly identifies the XLK 2:1 stock split, describes the adjustment approach, and uses split-adjusted prices (e.g., mentions adjusted XLK prices in the $100–120 range rather than raw $200–226); the `backtest_results.json` reflects correctly adjusted momentum scores
- [ ] `data_quality_issues_addressed` — Report addresses both the XLF duplicate row (week 12, keeping $40.80 over $41.30) and the XLE missing data (weeks 15–17, linear interpolation yielding ~$89.63, ~$90.15, ~$90.68); mentions the specific data quality steps taken
- [ ] `exclusion_rule_applied` — Report and/or JSON show that XLE was excluded from period 3 selection due to negative 4-week momentum, replaced by XLI; full credit requires all four elements: (1) explicit citation of the 4-week momentum exclusion rule, (2) XLE identified as excluded, (3) XLI shown as its replacement in the period 3 portfolio, and (4) the specific negative 4-week momentum value (approximately –3.06%) stated in the report
- [ ] `total_return_accurate` — The reported/JSON total cumulative return is within 1 percentage point of 9.40% (the correct value with all data traps handled and exclusion rule applied); partial credit if within 2pp of 11.10% (correct split adjustment but missed exclusion rule)
- [ ] `sharpe_and_metrics_accurate` — Sharpe ratio, annualized return, max drawdown, and benchmark return are computed and reported; Sharpe within 1.5 of ground truth 6.72; benchmark return within 0.5pp of 3.67%
- [ ] `results_json_valid` — File `backtest_results.json` exists, parses as valid JSON, contains at minimum: (a) a performance object with explicitly named `total_return` (or `total_return_pct`) and `sharpe_ratio` fields, (b) a period-by-period array with at least 4 entries each containing a `selected_sectors` list and period returns, (c) a `transaction_costs` object with both a total amount and per-period cost breakdown
- [ ] `script_executable` — File `backtest.py` exists, runs without uncaught exceptions via `python3 backtest.py` from the workspace directory, and produces output containing a total return value within 2pp of the correct 9.40%

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json
    import re
    import csv
    import subprocess
    import math

    scores = {
        "report_file_exists": 0.0,
        "split_adjustment_handled": 0.0,
        "data_quality_issues_addressed": 0.0,
        "exclusion_rule_applied": 0.0,
        "total_return_accurate": 0.0,
        "sharpe_and_metrics_accurate": 0.0,
        "results_json_valid": 0.0,
        "script_executable": 0.0,
    }

    ws = workspace_path
    report_path = os.path.join(ws, "backtest_report.md")
    json_path = os.path.join(ws, "backtest_results.json")
    script_path = os.path.join(ws, "backtest.py")

    # Ground truth values
    GT_TOTAL_RETURN = 9.40        # % with exclusion rule
    GT_TOTAL_NO_EXCL = 11.10      # % without exclusion rule
    GT_SHARPE = 6.72
    GT_BENCH_RETURN = 3.67        # %
    GT_MAX_DD = 0.19              # %
    GT_ANN_RETURN = 27.58         # %
    GT_TC_TOTAL = 857.32          # USD
    GT_PERIOD_SELECTIONS = [
        {"XLK", "XLF", "XLE"},
        {"XLF", "XLE", "XLK"},
        {"XLF", "XLK", "XLI"},    # XLE excluded, XLI replaces
        {"XLF", "XLE", "XLK"},
    ]
    GT_PERIOD_RETURNS = [3.08, 0.40, 2.03, 3.60]  # %

    # ---- 1. Report file exists ----
    if not os.path.isfile(report_path):
        return scores
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return scores
    if len(content.strip()) < 200:
        return scores

    has_sections = sum(1 for pat in [
        r'(?i)(data|preprocessing|cleaning)',
        r'(?i)(momentum|score|ranking)',
        r'(?i)(performance|metric|return|sharpe)',
        r'(?i)(benchmark|SPY|comparison)',
    ] if re.search(pat, content))
    if has_sections >= 3 and len(content.strip()) >= 500:
        scores["report_file_exists"] = 1.0
    elif len(content.strip()) >= 500:
        scores["report_file_exists"] = 0.75
    else:
        scores["report_file_exists"] = 0.5

    # ---- 2. Split adjustment ----
    has_split_mention = bool(re.search(
        r'(?i)\b(stock\s*split|split|2[\s:-]*for[\s:-]*1|2\s*:\s*1)\b', content))
    has_xlk_context = has_split_mention and bool(re.search(r'(?i)XLK', content))

    xlk_adj_evidence = bool(re.search(r'\b10[0-3]\.\d{1,2}\b', content))
    xlk_pre_halved = bool(re.search(r'(?i)(divid|halv|adjust|multiply).{0,80}(split|XLK)', content)) or \
                     bool(re.search(r'(?i)(split|XLK).{0,80}(divid|halv|adjust|multiply)', content))

    if has_xlk_context and (xlk_adj_evidence or xlk_pre_halved):
        scores["split_adjustment_handled"] = 1.0
    elif has_xlk_context:
        scores["split_adjustment_handled"] = 0.75
    elif has_split_mention:
        scores["split_adjustment_handled"] = 0.5
    elif xlk_adj_evidence:
        scores["split_adjustment_handled"] = 0.25

    # ---- 3. Data quality issues ----
    dq_score = 0.0

    has_dup_mention = bool(re.search(r'(?i)(duplicat)', content))
    has_xlf_dup = has_dup_mention and bool(re.search(r'(?i)XLF', content))
    has_dup_value = bool(re.search(r'40\.80', content)) or bool(re.search(r'41\.30', content))

    if has_xlf_dup and has_dup_value:
        dq_score += 0.5
    elif has_xlf_dup:
        dq_score += 0.35
    elif has_dup_mention:
        dq_score += 0.15

    has_missing_mention = bool(re.search(r'(?i)(missing|interpol|gap)', content))
    has_xle_missing = has_missing_mention and bool(re.search(r'(?i)XLE', content))
    has_interp_values = bool(re.search(r'89\.6', content)) or bool(re.search(r'90\.1', content)) or \
                        bool(re.search(r'90\.6', content))

    if has_xle_missing and has_interp_values:
        dq_score += 0.5
    elif has_xle_missing:
        dq_score += 0.35
    elif has_missing_mention:
        dq_score += 0.15

    scores["data_quality_issues_addressed"] = min(dq_score, 1.0)

    # ---- 4. Exclusion rule ----
    has_4w_rule = bool(re.search(
        r'(?i)(4[\s-]*week|four[\s-]*week|short[\s-]*term).{0,30}(momentum|exclusion|filter|negative)',
        content))

    has_xle_excluded = bool(re.search(
        r'(?i)XLE.{0,120}(exclud|remov|skip|drop|negative|disqualif|fail)',
        content)) or bool(re.search(
        r'(?i)(exclud|remov|skip|drop|disqualif).{0,120}XLE',
        content))

    has_xli_in_p3 = False
    for pat in [
        r'(?i)(period|rebalanc).{0,30}3.{0,120}XLI',
        r'(?i)XLI.{0,120}(period|rebalanc).{0,30}3',
        r'(?i)(week\s*22|third).{0,120}XLI',
    ]:
        if re.search(pat, content):
            has_xli_in_p3 = True
            break

    neg_4w_value = bool(re.search(r'-\s*3\.0[0-9]', content))

    if has_xle_excluded and has_xli_in_p3 and has_4w_rule and neg_4w_value:
        scores["exclusion_rule_applied"] = 1.0
    elif has_xle_excluded and has_xli_in_p3 and has_4w_rule:
        scores["exclusion_rule_applied"] = 0.75
    elif has_xle_excluded and has_xli_in_p3:
        scores["exclusion_rule_applied"] = 0.5
    elif has_4w_rule and (has_xle_excluded or has_xli_in_p3):
        scores["exclusion_rule_applied"] = 0.5
    elif has_4w_rule or neg_4w_value:
        scores["exclusion_rule_applied"] = 0.25
    elif has_xle_excluded or has_xli_in_p3:
        scores["exclusion_rule_applied"] = 0.25

    # ---- 5. Total return accuracy ----
    json_data = None
    if os.path.isfile(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                json_data = json.load(f)
        except Exception:
            pass

    def extract_return_value(data, text):
        """Try to extract total return from JSON or report text."""
        candidates = []
        if isinstance(data, dict):
            for key_path in [
                ["performance", "total_return_pct"],
                ["performance", "total_return"],
                ["total_return_pct"],
                ["total_return"],
                ["results", "total_return_pct"],
                ["results", "total_return"],
                ["metrics", "total_return_pct"],
                ["summary", "total_return_pct"],
            ]:
                obj = data
                for k in key_path:
                    if isinstance(obj, dict) and k in obj:
                        obj = obj[k]
                    else:
                        obj = None
                        break
                if isinstance(obj, (int, float)):
                    val = obj
                    if abs(val) < 1:
                        val *= 100
                    candidates.append(val)

        for m in re.finditer(r'(?i)(?:total|cumulative)\s*(?:return|performance)[:\s]*[~≈]?\s*([+-]?\d+\.?\d*)\s*%', text):
            candidates.append(float(m.group(1)))
        for m in re.finditer(r'(?i)([+-]?\d+\.?\d*)\s*%\s*(?:total|cumulative)\s*(?:return)', text):
            candidates.append(float(m.group(1)))

        return candidates

    return_candidates = extract_return_value(json_data, content)

    best_return_score = 0.0
    for val in return_candidates:
        if abs(val - GT_TOTAL_RETURN) <= 1.0:
            best_return_score = max(best_return_score, 1.0)
        elif abs(val - GT_TOTAL_RETURN) <= 2.0:
            best_return_score = max(best_return_score, 0.75)
        elif abs(val - GT_TOTAL_NO_EXCL) <= 2.0:
            best_return_score = max(best_return_score, 0.5)
        elif 5.0 <= val <= 15.0:
            best_return_score = max(best_return_score, 0.25)

    scores["total_return_accurate"] = best_return_score

    # ---- 6. Sharpe and metrics ----
    metrics_score = 0.0

    sharpe_found = False
    for m in re.finditer(r'(?i)sharpe[:\s]*[~≈]?\s*([+-]?\d+\.?\d*)', content):
        val = float(m.group(1))
        if abs(val - GT_SHARPE) <= 1.5:
            metrics_score += 0.35
            sharpe_found = True
            break
        elif abs(val - GT_SHARPE) <= 3.0:
            metrics_score += 0.15
            sharpe_found = True
            break
    if not sharpe_found and json_data:
        for kp in [["performance", "sharpe_ratio"], ["sharpe_ratio"], ["metrics", "sharpe_ratio"]]:
            obj = json_data
            for k in kp:
                if isinstance(obj, dict) and k in obj:
                    obj = obj[k]
                else:
                    obj = None
                    break
            if isinstance(obj, (int, float)):
                if abs(obj - GT_SHARPE) <= 1.5:
                    metrics_score += 0.35
                elif abs(obj - GT_SHARPE) <= 3.0:
                    metrics_score += 0.15
                break

    bench_found = False
    for m in re.finditer(r'(?i)(?:benchmark|SPY)[:\s].{0,60}([+-]?\d+\.?\d*)\s*%', content):
        val = float(m.group(1))
        if abs(val - GT_BENCH_RETURN) <= 0.5:
            metrics_score += 0.25
            bench_found = True
            break
    if not bench_found:
        if re.search(r'3\.6[0-9]%|3\.7[0-9]%', content):
            metrics_score += 0.25

    dd_found = False
    for m in re.finditer(r'(?i)(?:max|maximum)\s*(?:draw\s*down)[:\s]*[~≈]?\s*([+-]?\d+\.?\d*)\s*%', content):
        val = float(m.group(1))
        if val <= 2.0:
            metrics_score += 0.2
            dd_found = True
            break
    if not dd_found:
        if re.search(r'(?i)draw\s*down', content):
            metrics_score += 0.1

    ann_ret_found = False
    for m in re.finditer(r'(?i)annual\w*\s*(?:return|ret)[:\s]*[~≈]?\s*([+-]?\d+\.?\d*)\s*%', content):
        val = float(m.group(1))
        if abs(val - GT_ANN_RETURN) <= 5.0:
            metrics_score += 0.2
            ann_ret_found = True
            break
    if not ann_ret_found:
        if re.search(r'(?i)annual', content) and re.search(r'2[2-9]\.\d+%|3[0-3]\.\d+%', content):
            metrics_score += 0.1

    scores["sharpe_and_metrics_accurate"] = min(metrics_score, 1.0)

    # ---- 7. Results JSON valid ----
    if json_data and isinstance(json_data, dict):
        json_score = 0.0

        has_performance = False
        for key in ["performance", "metrics", "summary", "results"]:
            if key in json_data and isinstance(json_data[key], dict):
                perf = json_data[key]
                has_tr = any(k for k in perf if k.lower() in (
                    "total_return", "total_return_pct",
                    "cumulative_return", "cumulative_return_pct"))
                has_sr = any(k for k in perf if k.lower() in (
                    "sharpe_ratio", "sharpe"))
                if has_tr and has_sr:
                    has_performance = True
                    json_score += 0.3
                elif has_tr:
                    has_performance = True
                    json_score += 0.2
                elif has_sr:
                    json_score += 0.1
                break

        has_periods = False
        for key in ["periods", "rebalancing_periods", "rebalancing", "period_results"]:
            if key in json_data:
                periods = json_data[key]
                if isinstance(periods, list) and len(periods) >= 4:
                    has_periods = True
                    json_score += 0.15
                    correct_p3 = False
                    for p in periods:
                        if isinstance(p, dict):
                            secs = p.get("selected_sectors",
                                         p.get("sectors",
                                               p.get("holdings", [])))
                            if isinstance(secs, list) and "XLI" in secs \
                                    and "XLE" not in secs:
                                correct_p3 = True
                    if correct_p3:
                        json_score += 0.2
                elif isinstance(periods, list) and len(periods) >= 3:
                    has_periods = True
                    json_score += 0.1
                break

        has_tc = False
        for key in ["transaction_costs", "costs", "tc"]:
            if key in json_data and isinstance(json_data[key], dict):
                has_tc = True
                tc_data = json_data[key]
                json_score += 0.15
                has_breakdown = any(
                    k for k in tc_data
                    if k.lower() in ("per_period", "periods",
                                     "breakdown", "period_costs"))
                if has_breakdown:
                    json_score += 0.2
                break
        if not has_tc:
            if isinstance(json_data.get("performance"), dict):
                if any("cost" in k.lower() or "tc" in k.lower()
                       for k in json_data["performance"]):
                    json_score += 0.05

        scores["results_json_valid"] = min(json_score, 1.0)

    # ---- 8. Script executable ----
    if os.path.isfile(script_path):
        scores["script_executable"] = 0.25

        try:
            result = subprocess.run(
                ["python3", script_path],
                capture_output=True,
                text=True,
                timeout=60,
                cwd=ws,
            )
            if result.returncode == 0:
                scores["script_executable"] = 0.5
                output = result.stdout + result.stderr
                for m in re.finditer(r'([+-]?\d+\.?\d*)\s*%?', output):
                    try:
                        val = float(m.group(1))
                        if abs(val) < 1 and abs(val * 100 - GT_TOTAL_RETURN) <= 2.0:
                            scores["script_executable"] = 1.0
                            break
                        elif abs(val - GT_TOTAL_RETURN) <= 2.0:
                            scores["script_executable"] = 1.0
                            break
                        elif abs(val - GT_TOTAL_NO_EXCL) <= 2.0:
                            scores["script_executable"] = 0.75
                            break
                    except ValueError:
                        continue
            else:
                stderr = result.stderr[:500] if result.stderr else ""
                if "import" in stderr.lower() or "module" in stderr.lower():
                    scores["script_executable"] = 0.25
        except subprocess.TimeoutExpired:
            scores["script_executable"] = 0.25
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

**Default rule**: If `backtest_report.md` does not exist or is empty, score **0.0** on all criteria below.

### Criterion 1: Data Quality Detection and Correction (Weight: 30%)

**Score 1.0**: The report identifies and correctly handles all three data quality issues: (1) XLK 2:1 stock split — explicitly states the split date, explains why prices halve, and shows split-adjusted price series used for all subsequent calculations; (2) XLF duplicate row — identifies the duplicate on 2024-03-22, states which value was kept ($40.80) and why; (3) XLE missing data for weeks 15–17 — describes linear interpolation, shows or references the interpolated values (~$89.63, ~$90.15, ~$90.68). All downstream calculations (momentum, returns) demonstrably use the cleaned data.

**Score 0.75**: Two of three data quality issues are correctly identified and handled, with the third either partially addressed or omitted. The handled issues show clear methodology. Alternatively, all three are mentioned but one is handled incorrectly (e.g., forward-fill instead of interpolation for XLE, or wrong duplicate kept for XLF).

**Score 0.5**: One data quality issue is fully handled, plus at least one other is acknowledged but not correctly resolved. For example, the split is detected and adjusted, but XLE missing data is forward-filled instead of interpolated, and the XLF duplicate is not mentioned. Or all three are mentioned superficially without showing how they affect the calculations.

**Score 0.25**: The report acknowledges that data quality may be an issue but does not specifically identify the XLK split, XLF duplicate, or XLE missing data. General statements like "checked for anomalies" without evidence of actual detection or correction.

**Score 0.0**: No data quality discussion. The report proceeds directly to calculations without any data preprocessing, or the report file does not exist.

### Criterion 2: Analytical Rigor and Calculation Accuracy (Weight: 30%)

**Score 1.0**: The report shows precise, traceable calculations. Momentum scores at each rebalancing point are computed and displayed (matching ground truth within ~1%). The 4-week momentum values used for the exclusion check are explicitly calculated and shown (not just the conclusion that a sector was excluded). Portfolio selections include the period 3 XLE exclusion due to the 4-week negative momentum rule, with XLI correctly substituted. Period returns are computed step by step. Performance metrics (total return ~9.4%, Sharpe, max drawdown, benchmark comparison) are all present with reasonable values. Transaction cost calculation covers commission and spread for each period.

**Score 0.75**: Calculations are mostly correct but with one significant error or omission: either the 4-week exclusion rule is correctly applied but the 4-week momentum values are not explicitly shown, or transaction costs are estimated rather than computed per-period, or one performance metric is missing. Momentum scores and period returns are present and mostly accurate. A total return of ~11.1% (correct split adjustment but missed exclusion rule) caps this criterion at 0.75.

**Score 0.5**: The report contains momentum calculations and portfolio selections, but multiple errors are present — for example, incorrect momentum scores due to partial data cleaning, wrong sector selections, or performance metrics that don't match the data. The overall structure is correct but numerical accuracy is poor. Or the calculations are correct but presented without showing intermediate work.

**Score 0.25**: The report describes the strategy conceptually but shows few actual calculations. Performance metrics appear to be estimated or generic rather than derived from the data. Key analytical steps (momentum scoring, portfolio construction, period returns) are described but not computed with specific numbers.

**Score 0.0**: No meaningful calculations. The report is a generic description of momentum strategies without reference to the specific data, or contains fabricated numbers that don't correspond to any reasonable interpretation of the input data.

### Criterion 3: Deliverable Completeness and Format Quality (Weight: 20%)

**Score 1.0**: All three deliverables are present and well-formed. `backtest_report.md` is structured with clear sections, uses markdown formatting effectively, and reads as a professional quantitative analysis document. `backtest_results.json` contains a clean, well-organized schema with performance metrics, period-by-period breakdown, and transaction cost summary — values are internally consistent with the report. `backtest.py` runs without errors using only standard library, handles data cleaning programmatically, and produces output matching the report.

**Score 0.75**: All three files exist and are functional, but one has quality issues: the JSON schema is flat or disorganized, the script has minor bugs (runs but doesn't produce fully correct output), or the report structure is adequate but not polished. Numbers across deliverables are mostly consistent.

**Score 0.5**: Two of three deliverables are present and functional. The missing one either doesn't exist or is a stub. Or all three exist but have significant quality issues (JSON is not valid, script crashes, report is fragmentary).

**Score 0.25**: Only the report exists with reasonable content. The JSON file is missing or invalid, and the Python script is missing or non-functional. The task is partially completed.

**Score 0.0**: Fewer than one deliverable is present, or all deliverables are empty/invalid stubs.

### Criterion 4: Strategy Understanding and Risk Awareness (Weight: 20%)

**Score 1.0**: The report demonstrates deep understanding of the momentum rotation strategy's mechanics and limitations. It discusses why the Sharpe ratio is inflated due to the short backtest period. It contextualizes the results against the benchmark meaningfully (not just stating "strategy > benchmark"). It notes how the 4-week exclusion rule affected portfolio composition and whether it helped or hurt performance in this specific period. Transaction cost impact is analyzed as a drag percentage. The report distinguishes between backtest results and forward-looking expectations.

**Score 0.75**: Good strategy understanding with most of the above elements. May miss the Sharpe inflation caveat or the forward-looking disclaimer but otherwise demonstrates solid grasp of the strategy mechanics and risk considerations.

**Score 0.5**: Basic strategy understanding. Presents results and benchmark comparison without much analytical depth. Mentions transaction costs but doesn't analyze their impact. Doesn't discuss limitations of the backtest period or the inflated Sharpe. Treats the results at face value.

**Score 0.25**: Superficial understanding. Describes what the strategy does but not why the results look the way they do. No discussion of risks, limitations, or caveats. Transaction costs may be mentioned but not computed.

**Score 0.0**: No evidence of strategy understanding. Results are presented without context, or the analysis contains fundamental misunderstandings of how momentum strategies work.
