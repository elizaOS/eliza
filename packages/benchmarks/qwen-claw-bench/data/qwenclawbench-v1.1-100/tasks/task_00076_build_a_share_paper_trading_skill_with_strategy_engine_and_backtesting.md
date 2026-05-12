---
id: task_00076_build_a_share_paper_trading_skill_with_strategy_engine_and_backtesting
name: Build A-Share Paper Trading Skill with Strategy Engine and Backtesting
category: Finance and Quantitative Trading
grading_type: hybrid
timeout_seconds: 1800
grading_weights:
  automated: 0.5
  llm_judge: 0.5
workspace_files:
- source: data/market/sh600519_daily.csv
  dest: data/market/sh600519_daily.csv
- source: data/market/sz000858_daily.csv
  dest: data/market/sz000858_daily.csv
- source: data/market/sz300750_daily.csv
  dest: data/market/sz300750_daily.csv
- source: data/market/sh688001_daily.csv
  dest: data/market/sh688001_daily.csv
- source: config/trading_fees.json
  dest: config/trading_fees.json
- source: config/trading_rules.yaml
  dest: config/trading_rules.yaml
- source: config/outdated_fees.json
  dest: config/outdated_fees.json
- source: config/strategy_params.yaml
  dest: config/strategy_params.yaml
- source: data/reference/stock_list.csv
  dest: data/reference/stock_list.csv
- source: data/reference/stock_list_v2.csv
  dest: data/reference/stock_list_v2.csv
- source: docs/existing_skills_inventory.md
  dest: docs/existing_skills_inventory.md
- source: docs/a_share_trading_guide.md
  dest: docs/a_share_trading_guide.md
- source: logs/previous_backtest_results.log
  dest: logs/previous_backtest_results.log
- source: data/market/index_sh000001.csv
  dest: data/market/index_sh000001.csv
- source: config/broker_api_config.yaml
  dest: config/broker_api_config.yaml
- source: data/market/sz000858_daily_adjusted.csv
  dest: data/market/sz000858_daily_adjusted.csv
- source: tests/test_sample_trades.json
  dest: tests/test_sample_trades.json
- source: data/holidays/cn_trading_holidays_2024.csv
  dest: data/holidays/cn_trading_holidays_2024.csv
- source: docs/notes_on_margin_trading.txt
  dest: docs/notes_on_margin_trading.txt
subcategory: Trading Strategy and Backtesting
---
## Prompt

We've been wanting to add a paper trading capability to our platform for a while now, and I finally have time to spec it out properly. I checked the existing skills inventory and we definitely don't have anything close — so this needs to be built from scratch.

Here's what I'm envisioning: a self-contained Python module (`paper_trading_skill.py`) that implements a complete A-share paper trading simulation engine. The workspace already has market data for several stocks, fee configurations, trading rules, strategy parameters, and stock reference lists — please use those as the foundation.

The module should include:

**A `PaperTradingEngine` class** that manages a virtual portfolio starting with the initial capital from the strategy params. It needs to handle buy and sell orders with proper A-share mechanics — T+1 settlement (can't sell shares bought today), minimum lot size of 100 shares, and correct price limit validation based on the stock's board type (main board, ChiNext, STAR market, ST stocks all have different limits). Transaction costs need to be calculated accurately using the fee schedule in the config directory — commission, stamp tax on sells, and transfer fees.

**A `MomentumValueStrategy` class** that implements the momentum-value hybrid strategy described in the strategy params. It should generate buy/sell signals based on moving average crossovers and volume confirmation. The strategy should respect all the position management rules (max single position, max total position) and risk controls (trailing stop loss, max daily loss, max drawdown).

**A `BacktestRunner` class** that can run the strategy against the historical data files and produce a results summary including total return, max drawdown, Sharpe ratio, win rate, and a trade log.

There are multiple data files and config files in the workspace — some may have overlapping or conflicting information, so please make sure you're working from the most current and appropriate sources.

The module should be importable and each class should work independently. Include a `if __name__ == "__main__"` block that demonstrates a backtest run across all four stocks in the market data directory and prints a summary.

Save everything to `paper_trading_skill.py`.

## Expected Behavior

The agent must produce a comprehensive, working Python module that correctly implements A-share paper trading simulation. The solution requires careful cross-referencing of multiple data sources — the workspace contains several config files and reference datasets, some of which are outdated, incorrectly labeled, or in conflicting formats. An effective solution identifies and uses the authoritative version of each data source rather than accepting the first or most prominently labeled option.

Key correctness requirements:

1. **Fee calculation** must use the fee parameters from the current fee schedule (not an older version with different rates). Transaction costs include commission on both sides, stamp tax on the sell side only, and transfer fees on both sides, with a minimum commission per trade.

2. **Price limit validation** must correctly apply board-type-specific daily limits. The limit percentages differ across main board, ChiNext (创业板), STAR Market (科创板), and ST-designated stocks. Multiple data sources provide this information; they do not all agree, and the correct values are documented in the trading rules config and the trading guide.

3. **Market data** for each stock must come from the appropriate CSV file. Not all files in the data directory are interchangeable — some contain prices in different units or represent different data products.

4. **Initial capital and position limits** must come from the strategy parameters config, not from other config files that may also contain capital-related fields.

5. The module's `__main__` block must actually execute the backtest across all four stocks and print a results summary without crashing.

## Grading Criteria

- [ ] **output_valid_python**: The file `paper_trading_skill.py` exists, is non-empty, and is syntactically valid Python.
- [ ] **three_core_classes_present**: All three required classes (`PaperTradingEngine`, a strategy class, `BacktestRunner`) are defined.
- [ ] **correct_fee_file_used**: Implementation uses the current fee schedule (`trading_fees.json`, with commission rate 0.00025) and does NOT load or reference `outdated_fees.json`.
- [ ] **transfer_fee_rate_correct**: Transfer fee rate is `0.00002` (0.002%) — the correct current rate — and the outdated rate `0.00006` (0.006%) does not appear in the implementation.
- [ ] **chinext_limit_correct**: ChiNext (sz300xxx) stocks are assigned a ±20% daily price limit, not the incorrect ±10% that appears in one of the stock reference files.
- [ ] **adjusted_data_file_avoided**: The implementation does NOT use `sz000858_daily_adjusted.csv` as the market data source for sz000858.
- [ ] **initial_capital_correct**: Initial capital of 1,000,000 CNY from `strategy_params.yaml` is used, not the conflicting value from another config file.
- [ ] **fee_calculation_correct**: Fee calculation for a sample trade produces the correct total cost (dynamic check against test cases in `tests/test_sample_trades.json`).
- [ ] **module_runs_no_crash**: The module's `__main__` block executes without crashing and produces backtest output.

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    import ast
    import subprocess
    from pathlib import Path

    scores = {
        "output_valid_python": 0.0,
        "three_core_classes_present": 0.0,
        "correct_fee_file_used": 0.0,
        "transfer_fee_rate_correct": 0.0,
        "chinext_limit_correct": 0.0,
        "adjusted_data_file_avoided": 0.0,
        "initial_capital_correct": 0.0,
        "fee_calculation_correct": 0.0,
        "module_runs_no_crash": 0.0,
    }

    # Blank submission guard
    has_response = False
    for event in transcript:
        if event.get("type") == "message":
            msg = event.get("message", {})
            if msg.get("role") == "assistant":
                has_response = True
                break
    if not has_response:
        return scores

    file_path = Path(workspace_path) / "paper_trading_skill.py"
    if not file_path.is_file():
        return scores

    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception:
        try:
            content = file_path.read_text(encoding="latin-1")
        except Exception:
            return scores

    if not content or content.strip() == "":
        return scores

    # 1. output_valid_python: valid Python syntax
    try:
        ast.parse(content)
        scores["output_valid_python"] = 1.0
    except SyntaxError:
        scores["output_valid_python"] = 0.25
        return scores  # No point checking further

    content_lower = content.lower()

    # 2. three_core_classes_present
    has_engine = bool(re.search(r'class\s+\w*(PaperTrad|SimulatedTrad|MockTrad)\w*', content))
    has_strategy = bool(re.search(r'class\s+\w*(Strategy|Signal|Momentum|Hybrid)\w*', content))
    has_backtest = bool(re.search(r'class\s+\w*(Backtest|Runner|Backtester)\w*', content))
    class_count = sum([has_engine, has_strategy, has_backtest])
    if class_count == 3:
        scores["three_core_classes_present"] = 1.0
    elif class_count == 2:
        scores["three_core_classes_present"] = 0.5
    elif class_count == 1:
        scores["three_core_classes_present"] = 0.25

    # 3. correct_fee_file_used
    # Correct: trading_fees.json (commission_rate: 0.00025)
    # Trap: outdated_fees.json (commission_rate: 0.0003)
    uses_correct_file = bool(re.search(r'trading_fees\.json', content))
    uses_outdated_file = bool(re.search(r'outdated_fees\.json', content))
    uses_correct_rate = bool(re.search(r'0\.00025', content))
    uses_wrong_rate = bool(re.search(r'0\.0003[^0-9]', content))

    if (uses_correct_file or uses_correct_rate) and not uses_outdated_file and not uses_wrong_rate:
        scores["correct_fee_file_used"] = 1.0
    elif uses_correct_file and not uses_outdated_file:
        scores["correct_fee_file_used"] = 0.75
    elif uses_outdated_file or uses_wrong_rate:
        scores["correct_fee_file_used"] = 0.0
    else:
        scores["correct_fee_file_used"] = 0.5  # Fee file handling unclear

    # 4. transfer_fee_rate_correct
    # Correct: 0.00002 (0.002%); Outdated trap: 0.00006 (0.006%)
    has_correct_rate = bool(re.search(r'0\.00002', content))
    has_trapped_rate = bool(re.search(r'0\.00006', content))
    if has_correct_rate and not has_trapped_rate:
        scores["transfer_fee_rate_correct"] = 1.0
    elif has_correct_rate and has_trapped_rate:
        # Both present — likely imported from wrong file or has both as constants
        scores["transfer_fee_rate_correct"] = 0.25
    elif has_trapped_rate:
        scores["transfer_fee_rate_correct"] = 0.0
    elif re.search(r'(?i)(transfer.*fee|过户费)', content):
        scores["transfer_fee_rate_correct"] = 0.5  # Transfer fee present, rate unclear

    # 5. chinext_limit_correct
    # Correct: 20% (0.20) for sz300xxx; Trap: stock_list_v2.csv says 10% (0.10)
    chinext_keywords = r'(?i)(sz300|chinext|创业板|300\d{3})'
    chinext_correct = bool(re.search(r'(?i)(sz300|chinext|创业板|300\d{3}).{0,80}?0\.2(?:0\b|(?![0-9]))', content))
    chinext_correct_rev = bool(re.search(r'(?i)0\.2(?:0\b|(?![0-9])).{0,80}?(sz300|chinext|创业板|300\d{3})', content))
    chinext_trapped = bool(re.search(r'(?i)(sz300|chinext|创业板|300\d{3}).{0,80}?0\.10?\b', content))
    chinext_trapped_rev = bool(re.search(r'(?i)0\.10?\b.{0,80}?(sz300|chinext|创业板|300\d{3})', content))

    if (chinext_correct or chinext_correct_rev) and not (chinext_trapped or chinext_trapped_rev):
        scores["chinext_limit_correct"] = 1.0
    elif chinext_correct or chinext_correct_rev:
        scores["chinext_limit_correct"] = 0.75  # Correct value present but trap also present
    elif chinext_trapped or chinext_trapped_rev:
        scores["chinext_limit_correct"] = 0.0   # Fell for stock_list_v2.csv trap
    elif re.search(chinext_keywords, content):
        scores["chinext_limit_correct"] = 0.5   # ChiNext mentioned, limit value unclear

    # 6. adjusted_data_file_avoided
    # Trap: sz000858_daily_adjusted.csv has prices in fen (~15000) instead of yuan (~150)
    uses_adjusted = bool(re.search(r'sz000858_daily_adjusted', content))
    uses_regular = bool(re.search(r'sz000858_daily\.csv|sz000858_daily["\']', content))
    if not uses_adjusted:
        scores["adjusted_data_file_avoided"] = 1.0
    elif uses_regular and uses_adjusted:
        # Both referenced — might be loading one and ignoring the other
        scores["adjusted_data_file_avoided"] = 0.5
    else:
        scores["adjusted_data_file_avoided"] = 0.0  # Only adjusted file used

    # 7. initial_capital_correct
    # Correct: 1,000,000 from strategy_params.yaml
    # Trap: 500,000 from broker_api_config.yaml's account.initial_capital
    has_correct_capital = bool(re.search(r'(?<!\d)1[,_]?000[,_]?000(?!\d)', content))
    has_wrong_capital = bool(re.search(r'(?<!\d)500[,_]?000(?!\d)', content))
    reads_strategy_params = bool(re.search(r'strategy_params', content))
    reads_broker_config = bool(re.search(r'broker_api_config', content))

    if has_correct_capital and not has_wrong_capital:
        scores["initial_capital_correct"] = 1.0
    elif has_correct_capital and has_wrong_capital:
        # Both present; broker config includes 500000 but also has 1M
        scores["initial_capital_correct"] = 0.5
    elif has_wrong_capital:
        scores["initial_capital_correct"] = 0.0  # Fell for broker_api_config trap
    elif reads_strategy_params:
        scores["initial_capital_correct"] = 0.75  # Reads right file, capital value not hardcoded
    else:
        scores["initial_capital_correct"] = 0.25

    # 8. fee_calculation_correct (dynamic check via subprocess)
    # trade_001: buy 1000 shares of sz000858 @ 150.00 → expected total = 40.50
    # Outdated fees trap: commission=45.00, transfer=9.00, total=54.00
    test_code = f"""
import sys, os
sys.path.insert(0, {repr(str(workspace_path))})
os.chdir({repr(str(workspace_path))})
try:
    from paper_trading_skill import PaperTradingEngine
    try:
        engine = PaperTradingEngine(initial_capital=1000000)
    except TypeError:
        try:
            engine = PaperTradingEngine(1000000)
        except TypeError:
            engine = PaperTradingEngine()
    total = None
    for method_name in ['calculate_transaction_cost', 'calculate_fees', 'calc_fees',
                        'compute_fees', 'transaction_cost', 'get_fees', 'calculate_cost',
                        'trade_cost', 'calc_cost', 'get_transaction_cost']:
        if hasattr(engine, method_name):
            m = getattr(engine, method_name)
            for args in [
                (150.0, 1000, 'buy', 'sz000858'),
                (150.0, 1000, 'buy'),
                ('sz000858', 150.0, 1000, 'buy'),
                (1000, 150.0, 'buy', 'sz000858'),
            ]:
                try:
                    r = m(*args)
                    if isinstance(r, (int, float)):
                        total = float(r)
                    elif isinstance(r, dict):
                        total = float(r.get('total', r.get('total_cost', r.get('total_fees', 0))))
                    if total is not None:
                        break
                except Exception:
                    pass
            if total is not None:
                break
    if total is not None:
        print(f"TOTAL_COST:{{total:.4f}}")
    else:
        print("METHOD_NOT_FOUND")
except ImportError as e:
    print(f"IMPORT_ERROR:{{e}}")
except Exception as e:
    print(f"ERROR:{{e}}")
"""
    try:
        proc = subprocess.run(
            ['python3', '-c', test_code],
            capture_output=True, text=True, timeout=20,
            cwd=workspace_path
        )
        out = proc.stdout.strip()
        if 'TOTAL_COST:' in out:
            val_str = out.split('TOTAL_COST:')[1].split('\n')[0]
            val = float(val_str)
            # Correct fees: commission=37.50, transfer=3.00, total=40.50
            # Outdated fees: commission=45.00, transfer=9.00, total=54.00
            if abs(val - 40.50) < 2.0:
                scores["fee_calculation_correct"] = 1.0
            elif abs(val - 54.00) < 3.0:
                scores["fee_calculation_correct"] = 0.0   # Outdated fee trap
            elif val > 10.0:
                scores["fee_calculation_correct"] = 0.5   # Some fee calc, value off
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass

    # If dynamic check produced no result, fall back to static proxy
    if scores["fee_calculation_correct"] == 0.0:
        if has_correct_rate and bool(re.search(r'0\.001', content)) and not has_trapped_rate:
            scores["fee_calculation_correct"] = 0.5

    # 9. module_runs_no_crash (dynamic: try to run __main__ block)
    if "if __name__" in content:
        try:
            proc = subprocess.run(
                ['python3', str(file_path)],
                capture_output=True, text=True, timeout=60,
                cwd=workspace_path
            )
            combined = proc.stdout + proc.stderr
            if proc.returncode == 0:
                # Ran to completion successfully
                if re.search(r'(?i)(return|backtest|trade|profit|loss|result|report)', combined):
                    scores["module_runs_no_crash"] = 1.0
                else:
                    scores["module_runs_no_crash"] = 0.75
            elif 'SyntaxError' in combined or 'IndentationError' in combined:
                scores["module_runs_no_crash"] = 0.0
            elif 'ImportError' in combined or 'ModuleNotFoundError' in combined:
                scores["module_runs_no_crash"] = 0.25
            else:
                # Runtime error (could be data-related, not code-quality issue)
                scores["module_runs_no_crash"] = 0.25
        except subprocess.TimeoutExpired:
            # Ran but didn't finish in 60s — partial credit
            scores["module_runs_no_crash"] = 0.5
        except Exception:
            pass
    else:
        # No __main__ block — cannot run
        scores["module_runs_no_crash"] = 0.0

    return scores
```

## LLM Judge Rubric

### Criterion 1: Data Source Navigation and Trap Avoidance (Weight: 35%)

The workspace contains multiple versions of fee schedules, stock reference files, market data files, and config files. An effective solution identifies and uses the authoritative version of each:
- Fee schedule: `config/trading_fees.json` (updated 2024-09-01) is correct; `config/outdated_fees.json` (2021-05-15) has outdated commission and transfer fee rates.
- Stock price limits: `config/trading_rules.yaml` and `docs/a_share_trading_guide.md` are authoritative; `data/reference/stock_list_v2.csv` (claiming "compliance team review") incorrectly lists ChiNext (sz300xxx) at 10% instead of the correct 20%.
- Market data: `data/market/sz000858_daily.csv` has prices in CNY (~150); `data/market/sz000858_daily_adjusted.csv` has prices ~100x larger (in fen, not yuan) — using it produces absurd P&L.
- Strategy parameters: `config/strategy_params.yaml` defines initial_capital=1,000,000; `config/broker_api_config.yaml` contains `account.initial_capital: 500000` and is explicitly marked "Do not use for paper trading."
- Backtest log: `logs/previous_backtest_results.log` is from an unrelated pairs trading strategy and should not be treated as prior paper trading infrastructure.

**Score 1.0**: All five data source selection decisions are correct, with reasoning documented in code comments or agent output. The implementation shows deliberate cross-referencing between conflicting sources rather than lucky file selection.
**Score 0.75**: Four of five source selections are correct, with reasoning for most. One source may be used incorrectly (e.g., wrong initial capital) but without compounding effects.
**Score 0.5**: Three of five correct. Two traps are fallen for, with some resulting correctness impact (e.g., wrong fee rate produces wrong transaction costs throughout).
**Score 0.25**: Only one or two correct. Major traps triggered — e.g., outdated fees AND wrong ChiNext limits — producing systematically incorrect transaction cost and order validation logic.
**Score 0.0**: Most data sources used incorrectly, with no evidence of evaluating which source is authoritative. Implementation uses outdated fees, wrong ChiNext limit, and/or fen-priced market data.

### Criterion 2: A-Share Domain Accuracy and Completeness (Weight: 35%)

**Score 1.0**: Full, correct implementation of all A-share-specific mechanics: (a) T+1 settlement enforced via date comparison (shares bought on T cannot be sold until T+1 using actual date tracking, not just a comment); (b) 100-share lot enforcement for buy orders with correct odd-lot sell handling; (c) board-type detection from stock codes (sh600xxx/sz000xxx=main, sz300xxx=ChiNext, sh688xxx=STAR) with correct per-board price limits computed against previous close; (d) transaction cost formula: commission rate × amount (min 5 CNY) on both sides, stamp tax 0.1% on sell only, transfer fee 0.002% on both sides; (e) momentum-value strategy implementing MA crossover with volume confirmation, trailing stop, and position size constraints from strategy_params; (f) BacktestRunner computing total return, max drawdown, Sharpe ratio, win rate, and trade log from real CSV data.
**Score 0.75**: Core mechanics correct (T+1, lot size, fee formula, board types) but one or two gaps — e.g., simplified price limit computation (not using previous close), or strategy lacks volume confirmation, or BacktestRunner skips one metric.
**Score 0.5**: Most mechanics present but with domain errors: e.g., price limits applied as absolute values, stamp tax applied on both sides, or MA crossover logic is generic placeholder rather than using the periods from strategy_params.
**Score 0.25**: Basic structure exists but significant domain errors: T+1 not actually enforced in execution logic, fees calculated with wrong formula, or backtest produces clearly nonsensical results (e.g., same entry/exit date, returns that don't match any computation of the underlying data).
**Score 0.0**: No meaningful A-share domain accuracy. Module is a skeleton with placeholder functions or produces results that cannot be reconciled with A-share trading rules.

### Criterion 3: Functional Code Quality and Execution Correctness (Weight: 30%)

**Score 1.0**: The module is fully functional: imports without error, `__main__` block runs to completion and produces formatted backtest output (at minimum: total return %, max drawdown %, trade count, and a few sample trades). Fee calculations for sample trades from `tests/test_sample_trades.json` match expected values within rounding tolerance. Code architecture is clean with proper class separation, error handling for common edge cases (insufficient funds, price limit exceeded, T+1 violation), and clear variable naming.
**Score 0.75**: Module runs to completion with reasonable output, minor issues in edge-case handling or output formatting. Fee calculation logic is correct even if not tested against all sample trades. Code structure is adequate.
**Score 0.5**: Module runs but with runtime warnings or partial output; some methods raise exceptions for non-trivial inputs. Overall architecture is functional but fragile. Fee calculation may have off-by-one or rounding issues.
**Score 0.25**: Module imports but `__main__` crashes or produces empty output. Core classes exist but methods are incomplete stubs. Would not function in a real integration.
**Score 0.0**: Module cannot be imported (syntax errors, broken imports, circular dependencies), or produces entirely fabricated/placeholder output with no evidence of actual computation.
