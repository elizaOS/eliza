---
id: task_00080_ai_quant_trading_strategy_ml_backtesting_system
name: AI Quant Trading Strategy - ML Backtesting System
category: Finance and Quantitative Trading
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: data/ohlcv_sample.csv
  dest: data/ohlcv_sample.csv
- source: data/ohlcv_extended.csv
  dest: data/ohlcv_extended.csv
- source: data/fundamentals.csv
  dest: data/fundamentals.csv
- source: config/strategy_params.yaml
  dest: config/strategy_params.yaml
- source: config/strategy_params_v2.yaml
  dest: config/strategy_params_v2.yaml
- source: config/model_registry.json
  dest: config/model_registry.json
- source: docs/architecture.md
  dest: docs/architecture.md
- source: docs/triple_barrier_reference.md
  dest: docs/triple_barrier_reference.md
- source: docs/feature_specs.md
  dest: docs/feature_specs.md
- source: logs/previous_backtest_run.log
  dest: logs/previous_backtest_run.log
- source: tests/test_features.py
  dest: tests/test_features.py
- source: tests/test_backtest.py
  dest: tests/test_backtest.py
- source: requirements.txt
  dest: requirements.txt
- source: data/macro_indicators.csv
  dest: data/macro_indicators.csv
- source: config/deploy_settings.json
  dest: config/deploy_settings.json
- source: data/splits_dividends.csv
  dest: data/splits_dividends.csv
- source: docs/README.md
  dest: docs/README.md
grading_weights:
  automated: 0.6
  llm_judge: 0.4
subcategory: Trading Strategy and Backtesting
---
## Prompt

We've been building out a quantitative trading backtesting system for the past few sprints, and I need you to bring it all together into a single self-contained `main.py`. The codebase documentation, config files, reference materials, data files, and test skeletons are all in the workspace — take whatever time you need to familiarize yourself with the project structure before writing anything.

Here's what the final script needs to do end-to-end:

**Feature Engineering** — Compute adaptive Bollinger Bands (bandwidth adjusting to recent volatility regime), RSI with divergence detection, and ATR-based volatility features. The architecture doc and reference materials describe the expected behavior. Make sure the divergence logic is actually correct per standard technical analysis definitions — I've seen some inconsistencies in our internal docs before so double-check against the canonical definition.

**Triple Barrier Labeling** — Implement the triple barrier method as described in our reference doc. Upper barrier is profit-take, lower is stop-loss, vertical barrier is max holding period. Label each bar based on which barrier is hit first.

**XGBoost Model** — Train a classifier on the labeled features. Handle class imbalance properly (the config has a `scale_pos_weight: auto` setting — compute it from the label distribution). Use walk-forward or time-series-aware train/test splitting, not random splits.

**Event-Driven Backtester** — Simulate trading based on model predictions. Apply commission and slippage. Track portfolio value over time. The config files have the relevant parameters for initial capital, commission rates, slippage, and confidence thresholds.

**Output** — Print a summary with total return, annualized Sharpe ratio, max drawdown, number of trades, and win rate. If matplotlib is available, save an equity curve comparing strategy vs. buy-and-hold to `output/equity_curve.png` and a feature importance bar chart to `output/feature_importance.png` (create the `output/` directory if needed); if matplotlib is unavailable, skip those steps gracefully without crashing.

The script should load data and parameters from the workspace files. There are multiple data files and config versions floating around — use your judgment on which ones are the correct/current versions. The system should work with the provided OHLCV data, and should also be able to fall back to generating synthetic data if something goes wrong with file loading.

Please make sure the existing unit tests in `tests/` would pass against your implementation — they test the function signatures and basic correctness of the feature engineering and backtesting modules.

One implementation detail that matters here: the test suite imports functions directly from `main.py`, so keep the module import-safe. The full training/backtest run should happen only under a normal script entrypoint, not during import.

## Expected Behavior

The agent must produce a complete, runnable `main.py` implementing the full ML-driven quant backtesting pipeline. The correct solution requires navigating several conflicting workspace files:

### Trap 1 — Data File Selection (Unit Mismatch)
- `data/ohlcv_sample.csv` contains 504 rows of correct daily OHLCV data with volume in raw units (e.g., 2,786,490).
- `data/ohlcv_extended.csv` contains 600 rows with a longer date range, appearing to be the "more complete" dataset. However, its volume column is silently in thousands (e.g., 2,830 means 2,830,000) without any labeling. The discrepancy is detectable by comparing volume magnitudes: ohlcv_sample.csv shows volumes in the millions (1M–5M), while ohlcv_extended.csv shows volumes in the low-thousands (2,000–5,000) for otherwise similar price-scale data — a ~1000x difference that cannot be explained by genuine trading differences.
- **Correct behavior**: Use `data/ohlcv_sample.csv` or generate simulated data with raw volume units. If using `ohlcv_extended.csv`, the agent must recognize and correct the volume scaling. Using `ohlcv_extended.csv` as-is would corrupt any volume-weighted features.

### Trap 2 — Config File Selection (Contradictory Parameters)
- `config/strategy_params.yaml` contains validated parameters: `commission_rate: 0.001`, `confidence_threshold: 0.65`, `stop_loss: -0.02`.
- `config/strategy_params_v2.yaml` has a misleading header comment ("Updated config - use this version") but contains three errors: `commission_rate: 0.01` (10x too high), `confidence_threshold: 0.50` (too permissive), and `stop_loss: 0.02` (positive sign — should be negative).
- **Correct behavior**: Use `config/strategy_params.yaml`. The agent should recognize that `strategy_params_v2.yaml`'s "last validated" date being more recent doesn't make it correct — the commission rate is unrealistically high for modern brokerages, the stop_loss sign is wrong (positive means it would never trigger as a loss barrier), and the threshold was deliberately raised to 0.65 in the validated config.

### Trap 3 — RSI Divergence Definition (Misleading Documentation)
- `docs/triple_barrier_reference.md` and standard technical analysis define bullish divergence as: price makes **lower** lows while RSI makes **higher** lows (indicating momentum shift).
- `docs/feature_specs.md` incorrectly states bullish divergence is when price makes **higher** lows while RSI makes **higher** lows (which is just a normal uptrend, not a divergence signal).
- **Correct behavior**: Implement the canonical definition — bullish divergence = price lower lows + RSI higher lows. The agent should recognize the error in `feature_specs.md` and use the standard TA definition.

### Trap 4 — Corporate Actions (Outdated/Unnecessary Data)
- `data/splits_dividends.csv` contains stock split and dividend adjustment data that looks like it should be applied to prices.
- `docs/README.md` and the nature of `ohlcv_sample.csv` indicate prices are already adjusted.
- **Correct behavior**: Do NOT apply the splits/dividends adjustments from `splits_dividends.csv`. The OHLCV data is already adjusted. Applying the adjustments would double-correct the prices, introducing artificial price jumps.

### Trap 5 — Architecture Doc vs. Config Hyperparameter Conflict
- `docs/architecture.md` states XGBoost should use `n_estimators=150, max_depth=6` — a stale value from an intermediate development version.
- `config/strategy_params.yaml` (the validated config, last validated 2023-11-15) specifies `n_estimators=200, max_depth=5` — these are the correct production-validated parameters.
- `logs/previous_backtest_run.log` also shows `n_estimators=150` (it was generated while the architecture doc was current, before the config was finalized). An agent that cross-references the log as confirmation of the architecture doc will use the wrong values.
- **Correct behavior**: Use `n_estimators=200, max_depth=5` from `strategy_params.yaml`. The config file is the authoritative parameter source; architecture docs describe the system but may lag behind tuning changes.

### Trap 6 — Deploy Settings Confusion
- `config/deploy_settings.json` contains a nested `backtest_params` block with `initial_capital: 250000`, `commission_rate: 0.0005`, `slippage_bps: 2`, and `confidence_threshold: 0.55`, accompanied by a comment saying "use these when validating backtests against production conditions."
- These values differ from `strategy_params.yaml` (initial_capital=100000, commission_rate=0.001, slippage_bps=5, confidence_threshold=0.65).
- **Correct behavior**: Use `strategy_params.yaml` exclusively for backtesting parameters. `deploy_settings.json` is a live-trading operations config; its `backtest_params` block represents live-scale production sizing, not the historical research backtest parameters validated by the quant team.

### Trap 7 — Model Registry Algorithm Recommendation
- `config/model_registry.json` includes a `rf_v2_20231201` entry with `"status": "recommended"` and a note stating it "outperforms all XGBoost variants on extended dataset" and is "recommended for new deployments."
- The recommended model uses RandomForest (not XGBoost) and was evaluated on `ohlcv_extended.csv` — the same volume-corrupted dataset from Trap 1.
- **Correct behavior**: Implement XGBoost as required by the project architecture and `strategy_params.yaml`. The model registry is an audit log; algorithm selection is defined by the architecture, not by registry status flags. The RandomForest recommendation is based on a flawed dataset evaluation and should be rejected.

### Additional Noise Files
- `data/fundamentals.csv`, `data/macro_indicators.csv`, `logs/previous_backtest_run.log` — these should not influence the core implementation (though the log is useful context for understanding prior runs).

### Core Implementation Requirements
1. **Feature Engineering**: Adaptive Bollinger Bands (window=20, std=2.0, bandwidth adjusting to volatility), RSI (period=14) with correct divergence detection, ATR (period=14).
2. **Triple Barrier Labeling**: profit_take=0.02, stop_loss=-0.02, max_holding=10 days. Label 1 if upper barrier hit first, 0 otherwise.
3. **XGBoost**: n_estimators=200, max_depth=5, learning_rate=0.05, auto-computed scale_pos_weight, time-series-aware splitting.
4. **Backtester**: initial_capital=100000, commission_rate=0.001, slippage=5bps, confidence_threshold=0.65.
5. **Output**: Print total return, annualized Sharpe, max drawdown, trade count, win rate. Optionally save equity curve to `output/equity_curve.png` — the `output/` directory must be created programmatically if it does not exist (`os.makedirs('output', exist_ok=True)`); if matplotlib is unavailable, this step should be skipped gracefully without crashing.
6. **Function signatures** must be compatible with the unit tests in `tests/test_features.py` and `tests/test_backtest.py`.

## Grading Criteria

- [ ] Script `main.py` exists, is syntactically valid Python, and runs without crashing
- [ ] Uses correct data source (`ohlcv_sample.csv` with raw volume units) — does NOT use `ohlcv_extended.csv` with uncorrected volume
- [ ] Uses correct configuration parameters from `strategy_params.yaml` (commission_rate=0.001, confidence_threshold=0.65, stop_loss=-0.02) — does NOT use the erroneous `strategy_params_v2.yaml` values
- [ ] Implements RSI divergence detection correctly (bullish divergence = price lower lows + RSI higher lows) — does NOT follow the incorrect definition from `feature_specs.md`
- [ ] Does NOT apply splits/dividends adjustments from `splits_dividends.csv` to already-adjusted OHLCV prices
- [ ] Uses correct XGBoost hyperparameters: n_estimators=200 and max_depth=5 from `strategy_params.yaml` — does NOT use the stale n_estimators=150 / max_depth=6 from `docs/architecture.md`
- [ ] Uses XGBoost classifier — does NOT switch to RandomForest despite the "recommended" status flag in `model_registry.json`
- [ ] Uses backtest parameters from `strategy_params.yaml` — does NOT apply the `backtest_params` block from `deploy_settings.json`
- [ ] Implements adaptive Bollinger Bands with configurable window and standard deviation parameters
- [ ] Implements RSI calculation with values correctly bounded between 0 and 100
- [ ] Implements ATR (Average True Range) calculation producing positive values
- [ ] Implements triple barrier labeling with upper (profit-take), lower (stop-loss), and vertical (max holding period) barriers
- [ ] Uses XGBoost classifier with proper class imbalance handling (auto-computed scale_pos_weight)
- [ ] Uses time-series-aware train/test splitting (not random shuffle)
- [ ] Implements event-driven backtester applying commission and slippage to trades
- [ ] Prints summary metrics including total return, Sharpe ratio, max drawdown, number of trades, and win rate
- [ ] Saves feature importance bar chart to `output/feature_importance.png` (or skips gracefully if matplotlib unavailable)
- [ ] Function signatures are compatible with the provided unit test files
- [ ] `main.py` is import-safe and the provided tests in `tests/test_features.py` and `tests/test_backtest.py` pass
- [ ] Running `python main.py` completes without crashing and either creates the expected output artifacts or explicitly skips plotting when matplotlib is unavailable
- [ ] Code is well-structured with clear separation between feature engineering, labeling, model training, and backtesting modules
- [ ] Handles edge cases gracefully (NaN values from indicator warmup periods, empty predictions, missing files)

## Automated Checks

```python
import ast
import os
import re
import subprocess
import sys
from pathlib import Path


def _run(cmd, cwd, timeout=120):
    import site
    env = os.environ.copy()
    user_site = site.getusersitepackages()
    if user_site:
        env["PYTHONPATH"] = user_site + os.pathsep + env.get("PYTHONPATH", "")
    user_bin = os.path.join(site.getuserbase(), "bin")
    if os.path.isdir(user_bin):
        env["PATH"] = user_bin + os.pathsep + env.get("PATH", "")
    try:
        completed = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return completed.returncode, completed.stdout + completed.stderr
    except Exception as exc:
        return 999, str(exc)


def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the main.py implementation with static and runtime checks."""

    results = {
        "main_py_exists": 0.0,
        "syntax_valid": 0.0,
        "required_functions_present": 0.0,
        "synthetic_fallback_present": 0.0,
        "xgboost_model": 0.0,
        "no_random_forest": 0.0,
        "correct_core_params": 0.0,
        "time_series_split_used": 0.0,
        "import_safe_for_tests": 0.0,
        "feature_tests_pass": 0.0,
        "backtest_tests_pass": 0.0,
        "main_executes": 0.0,
        "summary_metrics_printed": 0.0,
        "output_artifacts_or_graceful_skip": 0.0,
    }

    root = Path(workspace_path)
    main_py = root / "main.py"
    if not main_py.is_file():
        return results
    results["main_py_exists"] = 1.0

    try:
        content = main_py.read_text(encoding="utf-8")
    except Exception:
        return results

    content_lower = content.lower()

    try:
        tree = ast.parse(content)
        results["syntax_valid"] = 1.0
    except SyntaxError:
        return results

    function_names = {
        node.name for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
    }
    required = {
        "compute_adaptive_bollinger",
        "compute_rsi",
        "compute_atr",
        "detect_rsi_divergence",
        "run_backtest",
        "compute_buy_and_hold",
    }
    if required.issubset(function_names):
        results["required_functions_present"] = 1.0
    elif len(required.intersection(function_names)) >= 4:
        results["required_functions_present"] = 0.5

    if re.search(r"def\s+\w*(generate|simulate|create|make|synth)\w*", content, re.IGNORECASE):
        if re.search(r"(ohlcv|synthetic|simulated)", content_lower):
            results["synthetic_fallback_present"] = 1.0
        else:
            results["synthetic_fallback_present"] = 0.5

    if re.search(r"XGBClassifier|xgb\.XGBClassifier|xgboost\.XGBClassifier", content):
        results["xgboost_model"] = 1.0

    if not re.search(r"RandomForestClassifier|RandomForest\b", content):
        results["no_random_forest"] = 1.0

    correct_params = all(
        re.search(pattern, content, re.IGNORECASE)
        for pattern in [
            r"commission_rate\s*[=:]\s*0\.001",
            r"confidence_threshold\s*[=:]\s*0\.65",
            r"stop_loss\s*[=:]\s*-0\.02",
            r"n_estimators\s*[=:]\s*200",
            r"max_depth\s*[=:]\s*5",
            r"initial_capital\s*[=:]\s*100.?000",
        ]
    )
    wrong_params = any(
        re.search(pattern, content, re.IGNORECASE)
        for pattern in [
            r"commission_rate\s*[=:]\s*0\.01",
            r"confidence_threshold\s*[=:]\s*0\.5\b",
            r"stop_loss\s*[=:]\s*0\.02",
            r"n_estimators\s*[=:]\s*150",
            r"max_depth\s*[=:]\s*6",
            r"initial_capital\s*[=:]\s*250.?000",
        ]
    )
    if correct_params and not wrong_params:
        results["correct_core_params"] = 1.0
    elif correct_params:
        results["correct_core_params"] = 0.5

    if re.search(
        r"TimeSeriesSplit|walk.?forward|expanding.?window|time.?series.*split|shuffle\s*=\s*False",
        content,
        re.IGNORECASE,
    ):
        results["time_series_split_used"] = 1.0

    import_rc, import_out = _run(
        [sys.executable, "-c", "import main; print('IMPORT_OK')"],
        cwd=workspace_path,
        timeout=60,
    )
    if import_rc == 0 and "IMPORT_OK" in import_out:
        results["import_safe_for_tests"] = 1.0

    feature_rc, feature_out = _run(
        [sys.executable, "-m", "pytest", "tests/test_features.py", "-q"],
        cwd=workspace_path,
        timeout=120,
    )
    if feature_rc == 0:
        results["feature_tests_pass"] = 1.0
    elif "ModuleNotFoundError" not in feature_out and "No module named pytest" not in feature_out and results["required_functions_present"] > 0:
        results["feature_tests_pass"] = 0.5

    backtest_rc, backtest_out = _run(
        [sys.executable, "-m", "pytest", "tests/test_backtest.py", "-q"],
        cwd=workspace_path,
        timeout=120,
    )
    if backtest_rc == 0:
        results["backtest_tests_pass"] = 1.0
    elif "ModuleNotFoundError" not in backtest_out and "No module named pytest" not in backtest_out and results["required_functions_present"] > 0:
        results["backtest_tests_pass"] = 0.5

    run_rc, run_out = _run([sys.executable, "main.py"], cwd=workspace_path, timeout=180)
    if run_rc == 0:
        results["main_executes"] = 1.0

    if re.search(r"total return|sharpe|max drawdown|number of trades|win rate", run_out, re.IGNORECASE):
        results["summary_metrics_printed"] = 1.0
    elif run_rc == 0 and len(re.findall(r"\d+\.\d+|\d+%", run_out)) >= 3:
        results["summary_metrics_printed"] = 0.5

    output_dir = root / "output"
    equity_curve = output_dir / "equity_curve.png"
    feature_importance = output_dir / "feature_importance.png"
    graceful_skip = re.search(r"matplotlib.*unavailable|skip.*plot|plotting skipped", run_out, re.IGNORECASE)
    if equity_curve.exists() and feature_importance.exists():
        results["output_artifacts_or_graceful_skip"] = 1.0
    elif graceful_skip or output_dir.exists():
        results["output_artifacts_or_graceful_skip"] = 0.5

    return results
```

## LLM Judge Rubric

### Criterion 1: Trap Detection and Resolution Reasoning (Weight: 45%)
**Score 1.0**: The agent explicitly identifies and correctly resolves at least 5 of the 7 traps: (1) volume unit mismatch in ohlcv_extended.csv, (2) contradictory v2 config with wrong commission/stop-loss sign/threshold, (3) inverted RSI divergence definition in feature_specs.md, (4) double-adjustment risk from splits_dividends.csv, (5) stale XGBoost hyperparameters in architecture.md vs. validated config, (6) misleading backtest_params block in deploy_settings.json, (7) RandomForest "recommended" status in model_registry.json based on corrupted dataset. Code or comments demonstrate clear reasoning about why files were rejected or values overridden — e.g., why n_estimators=200 beats architecture doc's 150, why deploy_settings.json does not govern backtesting parameters, why RandomForest from model_registry is disqualified. The agent does not blindly follow "use this version" comments or "recommended" status flags.
**Score 0.75**: The agent correctly resolves at least 4 traps with explicit reasoning, and avoids the worst consequences of the remaining ones. Correctly uses XGBoost with validated hyperparameters and rejects both v2 config and deploy_settings.json values.
**Score 0.5**: The agent correctly handles at least 2 traps with clear reasoning. May use correct algorithm (XGBoost) and stop_loss sign but fall for other traps like architecture doc hyperparameters or deploy_settings capital, or generate simulated data thereby sidestepping the volume trap without acknowledging it.
**Score 0.25**: The agent falls for most traps — uses v2 config values, implements inverted divergence, uses wrong hyperparameters from architecture.md, or switches to RandomForest — but gets at least one thing right.
**Score 0.0**: The agent shows no awareness of any traps: blindly uses v2 config, inverted divergence, RandomForest from model_registry, architecture doc hyperparameters, deploy_settings capital, and applies splits to already-adjusted prices.

### Criterion 2: Technical Correctness and Domain Sophistication (Weight: 35%)
**Score 1.0**: The implementation demonstrates expert-level quantitative finance knowledge: RSI divergence detection correctly identifies price lower-lows with RSI higher-lows (bullish) and vice versa for bearish using proper lookback windows; triple barrier labeling correctly races barriers and assigns labels based on first touch; walk-forward or expanding-window cross-validation is properly implemented with no data leakage (features computed before labels, train strictly before test); the event-driven backtester correctly sequences signals, entries, exits, and position tracking with realistic assumptions. The adaptive Bollinger Band implementation genuinely adapts bandwidth to volatility regime (not just standard Bollinger Bands with a fixed multiplier).
**Score 0.75**: Core algorithms are implemented correctly with minor issues — e.g., walk-forward splitting is correct but the expanding window could be more sophisticated, or the backtester handles most edge cases but misses one (like partial fills or overlapping signals). The divergence detection and triple barrier logic are fundamentally sound.
**Score 0.5**: The pipeline runs end-to-end but contains meaningful technical errors: e.g., potential lookahead bias in feature computation, triple barrier labeling that doesn't properly handle the vertical barrier race condition, or RSI divergence that uses an overly simplistic heuristic that wouldn't work on real data. Walk-forward splitting exists but may have subtle leakage.
**Score 0.25**: Multiple significant technical errors: random train/test splits instead of time-series aware, triple barrier labeling that is essentially just sign-of-returns, divergence detection that is a placeholder, or a backtester that doesn't properly track positions and capital.
**Score 0.0**: The code is structurally present but technically broken — algorithms are stubs, key financial logic is missing or nonsensical, or the pipeline cannot produce meaningful results even on simulated data.

### Criterion 3: Code Quality, Architecture, and Professional Completeness (Weight: 20%)
**Score 1.0**: The code is well-organized with clear separation of concerns (data generation, feature engineering, labeling, modeling, backtesting, reporting), meaningful function/variable names, docstrings or comments explaining non-obvious logic, proper error handling, and a logical main execution flow. The pipeline is genuinely self-contained and would run without modification. Output includes informative logging or print statements showing pipeline progress and key metrics (Sharpe ratio, max drawdown, win rate, etc.).
**Score 0.75**: Code is well-structured and readable with most components cleanly separated. Minor issues like missing error handling for edge cases, sparse documentation in complex sections, or one or two hardcoded values that should be parameterized. Runs end-to-end with minimal issues.
**Score 0.5**: Code is functional but monolithic or poorly organized — e.g., one giant script with minimal function decomposition, inconsistent naming, or missing key performance metrics in output. May require minor fixes to run.
**Score 0.25**: Code has significant organizational problems — duplicated logic, confusing control flow, missing imports, or incomplete sections that would require substantial editing to run. Performance reporting is minimal or absent.
**Score 0.0**: Code is disorganized, incomplete, or clearly non-functional — missing critical sections, syntax errors throughout, or no coherent execution flow from data to results.