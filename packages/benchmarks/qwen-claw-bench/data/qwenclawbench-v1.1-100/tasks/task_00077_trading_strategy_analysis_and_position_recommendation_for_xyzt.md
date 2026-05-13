---
id: task_00077_trading_strategy_analysis_and_position_recommendation_for_xyzt
name: Trading Strategy Analysis and Position Recommendation for XYZT
category: Finance and Quantitative Trading
grading_type: hybrid
verification_method: rubric
timeout_seconds: 1800
workspace_files:
- source: data/market/XYZT_ohlcv_daily.csv
  dest: data/market/XYZT_ohlcv_daily.csv
- source: data/market/XYZT_ohlcv_intraday.csv
  dest: data/market/XYZT_ohlcv_intraday.csv
- source: data/signals/signal_report_20241115.json
  dest: data/signals/signal_report_20241115.json
- source: data/portfolio/portfolio_status.json
  dest: data/portfolio/portfolio_status.json
- source: data/portfolio/portfolio_status_summary.yaml
  dest: data/portfolio/portfolio_status_summary.yaml
- source: data/risk/risk_parameters.yaml
  dest: data/risk/risk_parameters.yaml
- source: data/risk/volatility_report.csv
  dest: data/risk/volatility_report.csv
- source: data/market/sector_performance.csv
  dest: data/market/sector_performance.csv
- source: data/signals/historical_signals_performance.csv
  dest: data/signals/historical_signals_performance.csv
- source: data/market/economic_calendar.json
  dest: data/market/economic_calendar.json
- source: data/market/correlation_matrix.csv
  dest: data/market/correlation_matrix.csv
- source: reports/previous_trade_notes.md
  dest: reports/previous_trade_notes.md
- source: reports/weekly_market_commentary.md
  dest: reports/weekly_market_commentary.md
- source: config/trading_rules.yaml
  dest: config/trading_rules.yaml
- source: data/signals/alternative_model_signal.json
  dest: data/signals/alternative_model_signal.json
grading_weights:
  automated: 0.55
  llm_judge: 0.45
subcategory: Trading Strategy and Backtesting
---
## Prompt

Our quant desk just flagged XYZT with a buy signal as of market close today (November 15th). Before we take any action Monday morning, I need a thorough trade recommendation written up and saved to `trading_decision.md`.

Here's what I'm looking for: pull together everything we have on XYZT — the daily and intraday price data, the signal report from our model, the current portfolio and risk constraints, volatility metrics, sector context, the upcoming economic calendar, and the historical track record of similar signals. There are various data files across `data/` and `config/` that should have everything you need. There may also be some older reports and alternative model outputs floating around in the workspace — use your judgment about what's current and reliable.

The write-up should cover signal assessment, technical context, a thorough risk analysis — what's the maximum position we can realistically take given all our constraints? Give me specific dollar amounts and share counts, not ballpark estimates — and a clear final recommendation with actionable entry parameters. Make sure to think carefully about how this fits with our current book.

Also, put together a `risk_summary.json` with the key trading parameters so the PMs can plug it straight into the order management system.

Be rigorous about using the most current data. We've had issues before with stale snapshots causing bad sizing decisions, so please verify timestamps and cross-check figures where multiple sources exist.

## Expected Behavior

The agent must synthesize data from approximately 15 files across multiple formats (CSV, JSON, YAML, Markdown) to produce two deliverables: a comprehensive narrative trading recommendation (`trading_decision.md`) and a structured parameter file (`risk_summary.json`). The correct solution requires navigating three data traps:

### Trap 1: Outdated Portfolio Data (data/portfolio/portfolio_status_summary.yaml vs data/portfolio/portfolio_status.json)
- `data/portfolio/portfolio_status.json` is timestamped `2024-11-15T16:30:00Z` and shows `available_cash: 320000`
- `data/portfolio/portfolio_status_summary.yaml` is timestamped `2024-11-12T09:00:00Z` and shows `available_cash: 520000`
- The agent should recognize the YAML file is 3 days stale and use the JSON file's $320,000 figure
- Using $520,000 would lead to recommending a position that is too large relative to actual available capital
- Additional staleness indicators in the YAML: it reports `holdings_count: 5` (vs 6 actual holdings in the JSON — UVWX was added after the YAML snapshot) and `Technology: 15.0%` (vs the current 18.0% from ABCD 3.6% + EFGH 14.4%), corroborating that the YAML is outdated
- Between the 10% single-position cap ($1,250,000 × 10% = $125,000) and available cash ($320,000), the 10% cap is the tighter constraint; however, the per-trade allocation limit (20% of $320,000 = $64,000 from trading_rules.yaml) further constrains the position when all limits are considered jointly — using the stale $520,000 figure would yield a per-trade limit of $104,000 instead of $64,000, materially inflating the recommended position size

### Trap 2: Correlation Unit Mismatch (data/market/correlation_matrix.csv vs data/risk/risk_parameters.yaml)
- `data/market/correlation_matrix.csv` expresses correlations as percentages (e.g., XYZT-ABCD = 78)
- `data/risk/risk_parameters.yaml` specifies `correlation_threshold: 0.7` in decimal form
- The agent must recognize this unit mismatch and correctly determine that XYZT-ABCD correlation is 0.78, which exceeds the 0.7 threshold
- This means XYZT and ABCD are highly correlated, which is relevant because the portfolio already holds ABCD ($45,000 position) and both are in the Technology sector
- The agent should flag this correlation risk and factor it into the position sizing and sector exposure analysis
- Current Technology sector exposure is 18% (ABCD at 3.6% + EFGH at 14.4%), and the max is 25%, so adding XYZT (Technology) is constrained to roughly 7% additional exposure (~$87,500)

### Trap 3: Contradictory Model Signals (data/signals/signal_report_20241115.json vs data/signals/alternative_model_signal.json)
- `data/signals/signal_report_20241115.json` shows a BUY signal with MEDIUM confidence (0.62) from model v3.2.1
- `data/signals/alternative_model_signal.json` shows a SELL signal with HIGH confidence (0.81) from an alternative model
- The alternative model has a deprecation notice buried in its metadata indicating it is not the current production model
- The agent should identify that the primary signal report (model v3.2.1) is the authoritative source and note the conflicting alternative signal while explaining why it should be discounted
- The agent should NOT simply average the two signals or defer to the higher confidence score

### Expected risk_summary.json Structure
The agent should produce a valid JSON file containing at minimum:
- `ticker`: "XYZT"
- `recommendation`: one of "BUY", "PASS", "REDUCE_SIZE" (or similar)
- `position_size_usd`: dollar amount approximately $64,000 (the per-trade allocation limit of 20% × $320K is the binding constraint); the grade function validates within ±15% of the dynamically computed multi-constraint maximum
- `position_size_shares`: integer share count consistent with position_size_usd / ~$51.85
- `stop_loss`: price level in the $49–$50.10 range
- `target_price`: approximately $54–$55
- `risk_level`: "medium" or "high"
- `constraints` or equivalent object capturing the binding constraint (sector exposure cap) and XYZT-ABCD correlation

### Additional Correct Analysis Points:
- **Historical signal performance**: For MEDIUM confidence BUY signals in the historical data, the win rate is approximately 73% (8 out of 11 signals hit their target), with an average gain of ~2.9% and average loss of ~-1.9%. For the specific double_bottom pattern, there is only one comparable signal in the dataset (TUVW, June 27, which hit its target), providing limited but supportive evidence.
- **Volatility context**: XYZT's 20-day historical volatility has risen from ~0.26 (early October) to ~0.39 on November 15, and IV rank is approximately 73 (elevated), suggesting higher risk and potentially wider stop-loss requirements
- **Economic calendar**: Fed minutes on 2024-11-20 and CPI on 2024-11-22 are high-impact events within the signal's 5-15 day timeframe, adding event risk; the same `economic_calendar.json` also lists other dated entries (e.g., jobless claims 2024-11-21, new home sales 2024-11-27) that a thorough write-up may cite alongside those two
- **XYZT earnings**: Scheduled for 2024-12-05, which falls within or near the end of the holding period; the trading rules impose a 5-day blackout before earnings for new positions (starting ~Nov 27), though the blackout only applies to new positions, not existing ones
- **Sector weakness**: Technology sector ETF (XTK) has declined approximately 2.6% over the last 10 trading days (from 182.64 on Nov 1 to 177.91 on Nov 15), representing a headwind
- **Volume spike on November 12**: XYZT traded 3.17 million shares on Nov 12, roughly 2.6x the typical daily volume (~1.2M), which should be identified and interpreted (potential capitulation or institutional repositioning during the pullback)
- **Position sizing**: Given all constraints (per-trade limit $64K = 20% × $320K cash, sector cap ~$87.5K, portfolio cap $125K, correlation with ABCD, elevated vol), the binding constraint is the per-trade allocation limit at $64,000; the recommended position should be conservatively sized in the $55K-$70K range (~1,060-1,350 shares at ~$51.85)
- **Per-trade allocation limit**: The trading rules specify `max_allocation_per_trade_pct: 20.0`, which applied to available cash of $320,000 yields a $64,000 per-trade limit. Depending on interpretation (single fill vs. building a position across multiple orders), this may serve as an additional binding constraint or merely an execution guideline. A strong answer should at least acknowledge this parameter when discussing position sizing constraints.
- **Stop-loss**: The signal suggests $49.50; the agent should evaluate this against the support level of $50.10 and the risk parameters (max 2% daily loss)

### Computational Precision Requirements
The grade function dynamically computes reference values from the workspace asset files rather than using hardcoded thresholds. The agent's outputs are validated against these computed references:
- **Position size**: Computed as min(per_trade_limit, sector_headroom, portfolio_cap, available_cash) from portfolio_status.json and trading_rules.yaml; model output checked within ±8% of the reference (~$64,000)
- **Available cash**: Must appear in the narrative and as an accurate field in risk_summary.json, within ±3% of the portfolio_status.json value ($320,000)
- **Win rate**: Computed from historical_signals_performance.csv by filtering MEDIUM confidence BUY signals; model output checked within ±5 percentage points of the computed reference (~72.7%)
- **Sector exposure**: Computed from portfolio holdings as sum of Technology-sector market_value / total_value; model output checked within ±2 percentage points of the reference (~18.0%)
- **Expected return**: Computed as win_rate × avg_gain − (1 − win_rate) × avg_loss from historical data; model output checked within ±0.2 percentage points (~1.6%)
- **Risk/reward ratio**: Computed as avg_gain / avg_loss from historical data; model output checked within ±0.2 (~1.52)
- **Constrained maximum position**: risk_summary.json position_size_usd must be within ±15% of the multi-constraint maximum computed from all binding constraints

### Multi-Level Quality Expectations
- **Basic completion**: Produces `trading_decision.md` with a clear recommendation, references the signal data, and provides a position size. May miss one or more traps but demonstrates engagement with the workspace files.
- **High-quality completion**: Correctly resolves all three data traps with explicit reasoning, produces both `trading_decision.md` and `risk_summary.json` with accurate numerical parameters, cross-references multiple data sources, and the recommendation logically follows from the integrated analysis with specific dollar amounts, share counts, and constraint citations.

The final recommendation should likely be a cautious/reduced-size BUY or a conditional BUY, given the mixed signals (positive pattern but elevated volatility, sector headwinds, upcoming macro events, and correlation concerns). A well-reasoned PASS would also be acceptable if properly justified.

## Grading Criteria

- [ ] Both output files `trading_decision.md` and `risk_summary.json` exist and are non-empty
- [ ] Contains an explicit trade recommendation (BUY, PASS, HOLD, or REDUCE SIZE) clearly stated in the narrative
- [ ] `risk_summary.json` is valid JSON containing required fields: recommendation, position_size_usd, stop_loss, target_price, and risk_level
- [ ] Position size in dollars computed correctly from constraints (per-trade limit from available cash × max_allocation_per_trade_pct, sector headroom, portfolio cap), landing within ±8% of the dynamically computed reference (~$64,000)
- [ ] Uses $320,000 as available cash from portfolio_status.json AND includes this value in the risk_summary.json available_cash field (within ±3% of the asset-derived figure)
- [ ] Does not present the stale $520,000 figure from portfolio_status_summary.yaml as the current available cash
- [ ] Identifies the high XYZT-ABCD correlation (0.78 exceeding the 0.7 threshold) and discusses its implications for position sizing
- [ ] Identifies the alternative model (v2.1) as deprecated and appropriately discounts its SELL signal in favor of the primary model
- [ ] Includes a specific stop-loss price level in the $49–$50.10 range based on signal data and support levels
- [ ] Discusses both Fed minutes (11/20) and CPI release (11/22) as upcoming risk events, with each event's specific date co-located in the same passage as the event mention, and cites at least one additional dated event from `economic_calendar.json` outside that Fed/CPI pair (e.g., Nov 19 NAHB, Nov 21 jobless claims, Nov 27 new home sales, or Dec 5 XYZT earnings)
- [ ] Correctly computes Technology sector exposure from portfolio holdings (within ±2% of asset-derived ~18%) and calculates headroom against the sector cap in both percentage and dollar terms
- [ ] Organizes the document with clear sections covering signal assessment, technical context, risk analysis, and recommendation
- [ ] Historical win rate for MEDIUM confidence BUY signals computed from signal_history data, output within ±5 percentage points of the asset-derived reference (~72.7%)
- [ ] Identifies XYZT's upcoming earnings (December 5) and discusses the pre-earnings blackout constraint from trading rules in the context of position timing
- [ ] Discusses how multiple constraints (sector cap, correlation, volatility, position limit) interact to jointly determine the final position size, not just listing them individually
- [ ] Explicitly reasons about data freshness using timestamps or file references when choosing between conflicting data sources (e.g., JSON vs YAML portfolio snapshots), including the specific timestamp gap (3 days between Nov 12 and Nov 15)
- [ ] Identifies the November 12 volume anomaly (~3.17M shares, ~2.6x average daily volume) and interprets its significance (capitulation, institutional repositioning, or similar)
- [ ] Computes expected return from historical signal data (win_rate × avg_gain − loss_rate × avg_loss), output within ±0.2 percentage points of asset-derived reference (~1.6%)
- [ ] Computes risk/reward ratio from historical signal data (avg_gain / avg_loss), output within ±0.2 of asset-derived reference (~1.52)
- [ ] `risk_summary.json` position_size_usd value is within ±15% of the jointly constrained maximum position computed from available cash, per-trade limit, sector headroom, and portfolio cap

## Automated Checks

```python
import os
import re
import json
import csv
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    """Grade trading_decision.md and risk_summary.json with dynamic asset computation."""

    result_keys = [
        "output_files_exist",
        "trade_action_present",
        "risk_summary_valid_json",
        "position_size_calculated",
        "correct_available_cash",
        "no_stale_cash_figure",
        "correlation_value_correct",
        "deprecated_model_identified",
        "stop_loss_included",
        "upcoming_events_considered",
        "sector_exposure_calculated",
        "rationale_section_exists",
        "historical_win_rate_correct",
        "earnings_blackout_considered",
        "constraint_interaction_analysis",
        "data_freshness_reasoning",
        "volume_anomaly_noted",
        "expected_return_calculated",
        "risk_reward_ratio_calculated",
        "max_position_with_constraints",
    ]

    scores = {k: 0.0 for k in result_keys}

    wp = Path(workspace_path)
    md_path = wp / "trading_decision.md"
    json_path = wp / "risk_summary.json"

    if not md_path.is_file():
        return scores

    content = md_path.read_text(encoding="utf-8", errors="replace")
    if not content.strip():
        return scores

    # ── helpers ──
    def yaml_float(text, key):
        m = re.search(rf'{re.escape(key)}:\s*([\d.]+)', text)
        return float(m.group(1)) if m else None

    def jval(data, patterns, depth=0):
        if depth > 3 or not isinstance(data, dict):
            return None
        for k, v in data.items():
            kn = k.lower().replace("_", "").replace("-", "")
            for p in patterns:
                if p in kn:
                    try:
                        return float(v)
                    except (ValueError, TypeError):
                        pass
            if isinstance(v, dict):
                r = jval(v, patterns, depth + 1)
                if r is not None:
                    return r
        return None

    # ── load reference data from workspace assets ──
    ref = {}
    try:
        pf_p = wp / "data" / "portfolio" / "portfolio_status.json"
        if pf_p.is_file():
            pf = json.loads(pf_p.read_text(encoding="utf-8", errors="replace"))
            ref["cash"] = pf["summary"]["available_cash"]
            ref["total"] = pf["summary"]["total_value"]
            tv = sum(h["market_value"] for h in pf.get("current_holdings", [])
                     if h.get("sector", "").lower() == "technology")
            ref["tech_pct"] = tv / ref["total"] * 100 if ref["total"] else 0
    except Exception:
        pass

    try:
        tr_p = wp / "config" / "trading_rules.yaml"
        if tr_p.is_file():
            trc = tr_p.read_text(encoding="utf-8", errors="replace")
            for ykey, rkey in [("max_allocation_per_trade_pct", "alloc_pct"),
                               ("max_position_pct_portfolio", "pos_pct")]:
                v = yaml_float(trc, ykey)
                if v is not None:
                    ref[rkey] = v
    except Exception:
        pass

    try:
        rp_p = wp / "data" / "risk" / "risk_parameters.yaml"
        if rp_p.is_file():
            rpc = rp_p.read_text(encoding="utf-8", errors="replace")
            v = yaml_float(rpc, "max_sector_exposure_pct")
            if v is not None:
                ref["sec_pct"] = v
    except Exception:
        pass

    try:
        hs_p = wp / "data" / "signals" / "historical_signals_performance.csv"
        if hs_p.is_file():
            with open(hs_p, "r", encoding="utf-8") as f:
                mb = [r for r in csv.DictReader(f)
                      if r.get("signal") == "BUY" and r.get("confidence") == "MEDIUM"]
            wins = [r for r in mb if r.get("hit_target") == "True"]
            losses = [r for r in mb if r.get("hit_target") == "False"]
            if mb:
                ref["wr"] = len(wins) / len(mb) * 100
            if wins:
                ref["avg_g"] = sum(abs(float(r["outcome_15d_pct"])) for r in wins) / len(wins)
            if losses:
                ref["avg_l"] = sum(abs(float(r["outcome_15d_pct"])) for r in losses) / len(losses)
            if all(k in ref for k in ("wr", "avg_g", "avg_l")):
                w = ref["wr"] / 100
                ref["exp_ret"] = w * ref["avg_g"] - (1 - w) * ref["avg_l"]
            if ref.get("avg_l", 0) > 0 and "avg_g" in ref:
                ref["rr"] = ref["avg_g"] / ref["avg_l"]
    except Exception:
        pass

    if "cash" in ref and "alloc_pct" in ref:
        ref["ptl"] = ref["cash"] * ref["alloc_pct"] / 100
    if "total" in ref and "sec_pct" in ref and "tech_pct" in ref:
        ref["sh"] = (ref["sec_pct"] - ref["tech_pct"]) / 100 * ref["total"]
    if "total" in ref and "pos_pct" in ref:
        ref["pc"] = ref["total"] * ref["pos_pct"] / 100
    lims = [ref[k] for k in ("ptl", "sh", "pc", "cash") if k in ref]
    if lims:
        ref["mp"] = min(lims)

    md_exists = True
    json_data = None
    if json_path.is_file():
        try:
            raw = json_path.read_text(encoding="utf-8", errors="replace").strip()
            if raw:
                json_data = json.loads(raw)
        except (json.JSONDecodeError, Exception):
            json_data = None

    scores["output_files_exist"] = 1.0 if (md_exists and json_data is not None) else 0.5 if md_exists else 0.0

    content_lower = content.lower()
    paragraphs = re.split(r'\n\s*\n', content)

    # --- trade_action_present ---
    action_patterns = [
        r'(?i)(?:recommend|decision|action|conclusion|verdict)[^\n]{0,100}(?:buy|pass|hold|reduce|long|purchase)',
        r'(?i)\b(?:buy|pass|hold|reduce\s*size|go\s*long|purchase)\b[^\n]{0,60}(?:recommend|decision|action)',
        r'(?i)(?:recommend|suggest|advise)[^\n]{0,60}(?:purchas|long\s+position|initiat|enter)',
        r'(?im)^#{1,4}[^\n]*(?:recommend|decision|conclusion)\s*\n+[^\n]*\b(?:buy|pass|hold|reduce)',
        r'(?i)\*\*\s*(?:BUY|PASS|HOLD|REDUCE\s*SIZE)\s*\*\*',
    ]
    if any(re.search(p, content) for p in action_patterns):
        scores["trade_action_present"] = 1.0

    # --- risk_summary_valid_json: structure + required fields + value reasonableness ---
    if json_data and isinstance(json_data, dict):
        required_fields = {"recommendation", "position_size_usd", "stop_loss", "target_price", "risk_level"}
        flat_vals = {}
        for k, v in json_data.items():
            flat_vals[k.lower().strip()] = v
            if isinstance(v, dict):
                for sk, sv in v.items():
                    flat_vals[sk.lower().strip()] = sv

        matched = sum(1 for rf in required_fields if any(rf.replace("_", "") in jk.replace("_", "") or jk.replace("_", "") in rf.replace("_", "") for jk in flat_vals))
        if matched >= 5:
            value_checks = 0
            for fk, fv in flat_vals.items():
                fk_norm = fk.replace("_", "").replace("-", "")
                if "positionsize" in fk_norm and "share" not in fk_norm:
                    try:
                        if 45000 <= float(fv) <= 100000:
                            value_checks += 1
                    except (ValueError, TypeError):
                        pass
                if "stoploss" in fk_norm:
                    try:
                        if 48.5 <= float(fv) <= 50.2:
                            value_checks += 1
                    except (ValueError, TypeError):
                        pass
                if "risklevel" in fk_norm:
                    if isinstance(fv, str) and fv.lower() in ("medium", "high"):
                        value_checks += 1
            scores["risk_summary_valid_json"] = 1.0 if value_checks >= 2 else 0.7
        elif matched >= 3:
            scores["risk_summary_valid_json"] = 0.5
    elif json_data is not None:
        scores["risk_summary_valid_json"] = 0.25

    # --- position_size_calculated: dynamic reference from assets ---
    if "mp" in ref:
        rp = ref["mp"]
        lo1, hi1 = rp * 0.92, rp * 1.08
        lo2, hi2 = rp * 0.78, rp * 1.22
        found = None
        if json_data and isinstance(json_data, dict):
            found = jval(json_data, ["positionsizeusd", "positionsize", "tradesize",
                                     "tradevalue", "allocationusd", "recommendedposition",
                                     "investmentamount", "ordersize", "notionalvalue",
                                     "dollaramount", "tradeamount", "finalposition"])
            if found is not None and found < lo2 * 0.3:
                found = None
        if found is None:
            ps_pats = [
                r'(?i)(?:position\s*siz|allocat|invest|trade\s*size)[^\n]{0,80}\$\s*([\d,]+(?:\.\d+)?)',
                r'(?i)\$\s*([\d,]+(?:\.\d+)?)[^\n]{0,80}(?:position|shares|xyzt)',
            ]
            for pat in ps_pats:
                for m in re.finditer(pat, content):
                    try:
                        v = float(m.group(1).replace(',', ''))
                        if lo2 <= v <= hi2:
                            found = v
                            break
                    except ValueError:
                        pass
                if found is not None:
                    break
        if found is not None:
            if lo1 <= found <= hi1:
                scores["position_size_calculated"] = 1.0
            elif lo2 <= found <= hi2:
                scores["position_size_calculated"] = 0.5

    # --- correct_available_cash: text $320K + risk_summary.json field check ---
    ref_cash = ref.get("cash")
    cash_patterns = [
        r'(?i)(?:cash|available|capital)[^\n]{0,80}320[,.]?000',
        r'320[,.]?000[^\n]{0,80}(?:cash|available|capital)',
        r'\$\s*320[,.]?000',
        r'(?i)\$?\s*320\s*k\b',
    ]
    has_320k = any(re.search(p, content) for p in cash_patterns)
    has_ts = bool(re.search(
        r'(?i)(?:timestamp|more\s+recent|latest|Nov(?:ember)?\s*1[2-5]|portfolio_status\.json|\.json\b[^\n]{0,40}(?:current|latest|newer))',
        content
    )) and bool(re.search(
        r'(?i)(?:stale|outdated|old(?:er)?|not\s+current|superseded|overrid|prefer\s+(?:the\s+)?(?:json|newer|latest)|\.yaml\b[^\n]{0,40}(?:stale|outdated|old))',
        content
    ))
    json_cash_ok = False
    if ref_cash and json_data and isinstance(json_data, dict):
        jc = jval(json_data, ["availablecash", "cashavailable"])
        if jc is not None and abs(jc - ref_cash) / ref_cash <= 0.03:
            json_cash_ok = True
    if has_320k and json_cash_ok:
        scores["correct_available_cash"] = 1.0
    elif has_320k and has_ts:
        scores["correct_available_cash"] = 0.75
    elif has_320k:
        scores["correct_available_cash"] = 0.5

    # --- no_stale_cash_figure: adjacent paragraph detection (±1 paragraph) ---
    stale_used_as_current = False
    for i, para in enumerate(paragraphs):
        mentions_520 = re.search(r'520[,.]?000', para)
        if not mentions_520:
            continue
        adjacent_text = para
        if i > 0:
            adjacent_text = paragraphs[i - 1] + "\n\n" + adjacent_text
        if i < len(paragraphs) - 1:
            adjacent_text = adjacent_text + "\n\n" + paragraphs[i + 1]
        is_explaining_stale = bool(re.search(
            r'(?i)\b(?:stale|outdated|old|disregard|ignore|not\s+current|incorrect|superseded|overrid|prefer|no\s+longer|obsolete)\b',
            adjacent_text
        ))
        if is_explaining_stale:
            continue
        heading_exempt = False
        for j in range(max(0, i - 3), i + 1):
            if re.search(r'(?im)^#{1,4}\s+.*(?:verif|fresh|compar|data\s+(?:quality|integrity)|portfolio\s+(?:review|reconcil))', paragraphs[j]):
                heading_exempt = True
                break
        if heading_exempt:
            continue
        presents_as_current = re.search(r'(?i)(?:available|current)\s+(?:cash|capital|funds?)\s+(?:is|of|at|=|:)[^\n]{0,20}520[,.]?000', para)
        presents_as_current2 = re.search(r'(?i)520[,.]?000[^\n]{0,20}(?:available|in\s+cash|current\s+cash)', para)
        if presents_as_current or presents_as_current2:
            stale_used_as_current = True
            break
    if not stale_used_as_current:
        scores["no_stale_cash_figure"] = 1.0

    # --- correlation_value_correct: must mention 0.78 or 78% near correlation and ABCD ---
    corr_score = 0.0
    for para in paragraphs:
        has_corr = re.search(r'(?i)\bcorrelat', para)
        has_abcd = re.search(r'\bABCD\b', para)
        has_value = re.search(r'(?:0\.7[5-9]|0\.8[0-2]|\b7[5-9]\s*%|\b78\b|\b80\b)', para)
        if has_corr and has_abcd and has_value:
            corr_score = 1.0
            break
        elif has_corr and has_abcd:
            corr_score = max(corr_score, 0.5)
    if corr_score == 0.0 and json_data and isinstance(json_data, dict):
        def search_json(d, depth=0):
            if depth > 3:
                return False
            if isinstance(d, dict):
                for k, v in d.items():
                    kl = k.lower()
                    if "correl" in kl:
                        try:
                            val = float(v)
                            if 0.7 <= val <= 0.85 or 70 <= val <= 85:
                                return True
                        except (ValueError, TypeError):
                            pass
                    if isinstance(v, (dict, list)):
                        if search_json(v, depth + 1):
                            return True
            elif isinstance(d, list):
                for item in d:
                    if search_json(item, depth + 1):
                        return True
            return False
        if search_json(json_data):
            corr_score = 0.75
    scores["correlation_value_correct"] = corr_score

    # --- deprecated_model_identified ---
    dep_score = 0.0
    for para in paragraphs:
        has_deprecated = re.search(r'(?i)\b(?:deprecated|legacy|outdated|superseded|retired|obsolete)\b', para) or \
                         re.search(r'(?i)(?:no\s+longer\s+(?:the\s+)?(?:production|current|active|supported)|should\s+not\s+be\s+used|retained\s+for\s+comparison)', para)
        has_version = re.search(r'(?i)(?:v2[\.\s]*1|version\s*2[\.\s]*1|alternative\s+(?:model|signal)|older\s+(?:model|version))', para)
        if has_deprecated and has_version:
            dep_score = 1.0
            break
    if dep_score < 1.0:
        has_dep_any = bool(re.search(r'(?i)\b(?:deprecated|legacy|outdated|superseded|retired|obsolete)\b', content))
        has_ver_any = bool(re.search(r'(?i)(?:v2[\.\s]*1|version\s*2[\.\s]*1|alternative\s+(?:model|signal)|older\s+(?:model|version))', content))
        has_not_prod = bool(re.search(r'(?i)(?:not\s+(?:the\s+)?(?:current|production|primary)|no\s+longer\s+(?:in\s+)?(?:use|production))', content))
        if has_dep_any and has_ver_any:
            dep_score = max(dep_score, 0.75)
        elif has_not_prod and has_ver_any:
            dep_score = max(dep_score, 0.5)
    scores["deprecated_model_identified"] = dep_score

    # --- stop_loss_included: price + reasoning context for full score ---
    stop_score = 0.0
    has_sl_reasoning = bool(re.search(
        r'(?i)(?:stop[\-_ ]?loss|exit)[^\n]{0,150}(?:support|resistance|\b50[\.\s]*10|risk\s+param|max(?:imum)?\s+(?:daily\s+)?loss|drawdown|\b2\s*%)',
        content
    )) or bool(re.search(
        r'(?i)(?:support|resistance|\b50[\.\s]*10|risk\s+param|max(?:imum)?\s+(?:daily\s+)?loss|\b2\s*%)[^\n]{0,150}(?:stop[\-_ ]?loss|exit)',
        content
    ))
    sl_patterns = [
        r'(?i)stop[\-_ ]?loss[^\n]{0,80}?\$?\s*(\d+\.\d{1,2})',
        r'(?i)\$?\s*(\d+\.\d{1,2})[^\n]{0,80}?stop[\-_ ]?loss',
    ]
    for pat in sl_patterns:
        for m in re.finditer(pat, content):
            try:
                val = float(m.group(1))
                if 48.5 <= val <= 50.2:
                    stop_score = 1.0 if has_sl_reasoning else 0.5
                    break
            except ValueError:
                pass
        if stop_score > 0:
            break
    if stop_score == 0 and json_data and isinstance(json_data, dict):
        for k, v in json_data.items():
            if "stop" in k.lower():
                try:
                    val = float(v)
                    if 48.5 <= val <= 50.2:
                        stop_score = 1.0 if has_sl_reasoning else 0.5
                except (ValueError, TypeError):
                    pass
            if isinstance(v, dict):
                for sk, sv in v.items():
                    if "stop" in sk.lower():
                        try:
                            val = float(sv)
                            if 48.5 <= val <= 50.2:
                                stop_score = max(stop_score, 1.0 if has_sl_reasoning else 0.5)
                        except (ValueError, TypeError):
                            pass
    scores["stop_loss_included"] = stop_score

    # --- upcoming_events_considered: Fed and CPI with co-located dates + another economic-calendar date ---
    has_fed = bool(re.search(r'(?i)\b(?:fed|fomc|federal\s+reserve|meeting\s+minutes)\b', content))
    has_cpi = bool(re.search(r'(?i)\bCPI\b', content))
    has_d1120 = bool(re.search(r'(?:11[/-]20|November\s*20|Nov\.?\s*20)', content))
    has_d1122 = bool(re.search(r'(?:11[/-]22|November\s*22|Nov\.?\s*22)', content))
    # Dated entries in economic_calendar.json other than 11/20 and 11/22 (proves calendar file use beyond Fed/CPI)
    extra_cal_date_re = re.compile(
        r'(?:'
        r'11[/-]19|November\s*19|Nov\.?\s*19|2024[/-]11[/-]19|'
        r'11[/-]21|November\s*21|Nov\.?\s*21|2024[/-]11[/-]21|'
        r'11[/-]27|November\s*27|Nov\.?\s*27|2024[/-]11[/-]27|'
        r'12[/-]0?5|December\s*5|Dec\.?\s*5|2024[/-]12[/-]0?5|'
        r'11月0?19日|11月19[日号]|11月0?21日|11月21[日号]|'
        r'11月0?27日|11月27[日号]|12月0?5日|12月05日|12月5[日号]|'
        r'2024年11月0?19日|2024年11月0?21日|2024年11月0?27日|2024年12月0?5日'
        r')',
        re.I,
    )
    has_extra_cal_date = bool(extra_cal_date_re.search(content))
    fed_date_colocated = False
    cpi_date_colocated = False
    for para in paragraphs:
        p_fed = bool(re.search(r'(?i)\b(?:fed|fomc|federal\s+reserve|meeting\s+minutes)\b', para))
        p_d1120 = bool(re.search(r'(?:11[/-]20|November\s*20|Nov\.?\s*20)', para))
        p_cpi = bool(re.search(r'(?i)\bCPI\b', para))
        p_d1122 = bool(re.search(r'(?:11[/-]22|November\s*22|Nov\.?\s*22)', para))
        if p_fed and p_d1120:
            fed_date_colocated = True
        if p_cpi and p_d1122:
            cpi_date_colocated = True
    if fed_date_colocated and cpi_date_colocated:
        scores["upcoming_events_considered"] = 1.0 if has_extra_cal_date else 0.5
    elif has_fed and has_cpi and has_d1120 and has_d1122:
        scores["upcoming_events_considered"] = 0.75
    elif has_fed and has_cpi and (has_d1120 or has_d1122):
        scores["upcoming_events_considered"] = 0.5
    elif has_fed and has_cpi:
        scores["upcoming_events_considered"] = 0.25

    # --- sector_exposure_calculated: dynamic reference from portfolio holdings ---
    sec_score = 0.0
    ref_tech = ref.get("tech_pct")
    ref_sec_max = ref.get("sec_pct")
    if ref_tech is not None and ref_sec_max is not None:
        ref_hd_pct = ref_sec_max - ref_tech
        ref_hd_usd = ref_hd_pct / 100 * ref.get("total", 0)
        for para in paragraphs:
            if not (re.search(r'(?i)\bsector\b', para) and
                    re.search(r'(?i)(?:\btechnolog|\btech\b)', para)):
                continue
            pct_vals = [float(x) for x in re.findall(r'(\d+(?:\.\d+)?)\s*%', para)]
            tech_ok = any(abs(v - ref_tech) <= 2 for v in pct_vals)
            hd_pct_ok = any(abs(v - ref_hd_pct) <= 2 for v in pct_vals)
            hd_usd_ok = False
            if ref_hd_usd > 0:
                for um in re.finditer(r'\$\s*([\d,]+(?:\.\d+)?)\s*(?:k|K)?', para):
                    uv = float(um.group(1).replace(',', ''))
                    if um.group(0).rstrip().lower().endswith('k'):
                        uv *= 1000
                    if abs(uv - ref_hd_usd) / ref_hd_usd <= 0.15:
                        hd_usd_ok = True
                        break
            if tech_ok and hd_pct_ok and hd_usd_ok:
                sec_score = 1.0
                break
            elif tech_ok and (hd_pct_ok or hd_usd_ok):
                sec_score = max(sec_score, 0.75)
            elif tech_ok or hd_pct_ok or hd_usd_ok:
                sec_score = max(sec_score, 0.5)
    scores["sector_exposure_calculated"] = sec_score

    # --- rationale_section_exists: sections + content depth ---
    section_patterns = [
        r'(?im)^#{1,4}\s+.*(?:signal|assessment|model\s+eval)',
        r'(?im)^#{1,4}\s+.*(?:technical|price|market|chart)',
        r'(?im)^#{1,4}\s+.*(?:risk|exposure|constraint)',
        r'(?im)^#{1,4}\s+.*(?:recommend|conclusion|decision|verdict|position\s+siz)',
    ]
    section_count = sum(1 for p in section_patterns if re.search(p, content))
    word_count = len(content.split())
    if section_count >= 3 and word_count >= 600:
        scores["rationale_section_exists"] = 1.0
    elif section_count >= 3:
        scores["rationale_section_exists"] = 0.75
    elif section_count >= 2:
        scores["rationale_section_exists"] = 0.5

    # --- historical_win_rate_correct: dynamic reference from signal CSV ---
    wr_score = 0.0
    ref_wr = ref.get("wr")
    if ref_wr is not None:
        wr_patterns = [
            r'(?i)(?:win|success|hit)[\s_-]?rate[^\n]{0,50}?(\d+(?:\.\d+)?)\s*%',
            r'(?i)(\d+(?:\.\d+)?)\s*%[^\n]{0,50}?(?:win|success|hit)[\s_-]?rate',
            r'(?i)(?:hit\s+(?:their\s+)?target|reached?\s+(?:their\s+)?target|succeeded)[^\n]{0,50}?(\d+(?:\.\d+)?)\s*%',
            r'(?i)(\d+(?:\.\d+)?)\s*%[^\n]{0,50}?(?:hit\s+(?:their\s+)?target|reached?\s+target|succeeded)',
        ]
        for pat in wr_patterns:
            for m in re.finditer(pat, content):
                try:
                    v = float(m.group(1))
                    if abs(v - ref_wr) <= 5:
                        wr_score = 1.0
                    elif abs(v - ref_wr) <= 10:
                        wr_score = max(wr_score, 0.5)
                except ValueError:
                    pass
        if wr_score < 1.0:
            frac_pats = [
                r'(?i)(\d+)\s*(?:out\s+of|/)\s*(\d+)[^\n]{0,80}(?:signal|trade|hit|target|succeed)',
                r'(?i)(?:signal|trade|target|succeed)[^\n]{0,80}(\d+)\s*(?:out\s+of|/)\s*(\d+)',
            ]
            for pat in frac_pats:
                for m in re.finditer(pat, content):
                    try:
                        num, den = int(m.group(1)), int(m.group(2))
                        if den > 0:
                            pct = num / den * 100
                            if abs(pct - ref_wr) <= 5:
                                wr_score = max(wr_score, 1.0)
                            elif abs(pct - ref_wr) <= 10:
                                wr_score = max(wr_score, 0.5)
                    except (ValueError, IndexError):
                        pass
    scores["historical_win_rate_correct"] = wr_score

    # --- earnings_blackout_considered: XYZT earnings Dec 5 + blackout rule ---
    earn_score = 0.0
    earn_paras = [p for p in paragraphs if re.search(r'(?i)\bearnings?\b', p)]
    for para in earn_paras:
        has_blackout = bool(re.search(r'(?i)\b(?:blackout|restrict|pre[- ]?earnings?\b|no\s+new\s+positions?)', para))
        has_dec = bool(re.search(r'(?:12[/-]0?5|December\s*5|Dec\.?\s*5)', para))
        has_5day = bool(re.search(r'(?i)\b5\s*(?:trading\s+)?days?\b', para))
        if has_blackout and (has_dec or has_5day):
            earn_score = 1.0
            break
        elif has_blackout or (has_dec and has_5day):
            earn_score = max(earn_score, 0.75)
        elif has_dec or has_blackout:
            earn_score = max(earn_score, 0.5)
    if earn_score == 0.0 and earn_paras:
        earn_score = 0.25
    scores["earnings_blackout_considered"] = earn_score

    # --- constraint_interaction_analysis: multiple constraints discussed together ---
    ci_score = 0.0
    constraint_terms = [
        r'(?i)\bsector\s+(?:cap|limit|exposure|headroom|concentrat)',
        r'(?i)\bcorrelat',
        r'(?i)\bvolatilit',
        r'(?i)(?:per[- ]?trade|single[- ]?trade)\s+(?:limit|allocation|cap)',
        r'(?i)(?:position|single)\s+(?:limit|cap)\b.*?10\s*%',
        r'(?i)max(?:imum)?\s+(?:position|allocation|exposure)',
    ]
    for para in paragraphs:
        matched_constraints = sum(1 for cp in constraint_terms if re.search(cp, para))
        if matched_constraints >= 3:
            ci_score = 1.0
            break
        elif matched_constraints >= 2:
            ci_score = max(ci_score, 0.5)
    scores["constraint_interaction_analysis"] = ci_score

    # --- data_freshness_reasoning: explicit timestamp-based data selection ---
    df_score = 0.0
    freshness_evidence = [
        r'(?i)(?:timestamp|time\s*stamp)[^\n]{0,80}(?:Nov|11[/-]|2024)',
        r'(?i)(?:Nov(?:ember)?\s*1[2-5]|11[/-]1[2-5])[^\n]{0,80}(?:stale|outdated|old|newer|more\s+recent|current)',
        r'(?i)(?:stale|outdated|old|newer|more\s+recent)[^\n]{0,80}(?:Nov(?:ember)?\s*1[2-5]|11[/-]1[2-5])',
        r'(?i)portfolio_status\.json[^\n]{0,80}(?:current|latest|newer|more\s+recent|authoritative)',
        r'(?i)portfolio_status_summary[^\n]{0,80}(?:stale|outdated|old|not\s+current|superseded)',
        r'(?i)(?:YAML|\.yaml)[^\n]{0,80}(?:stale|outdated|old|not\s+current|superseded|3\s+days?)',
    ]
    matched_freshness = sum(1 for fp in freshness_evidence if re.search(fp, content))
    has_day_gap = bool(re.search(
        r'(?i)(?:3\s*(?:calendar\s+)?days?\b|three\s+days?\b|72\s*hours?\b|'
        r'Nov(?:ember)?\s*12[^\n]{0,40}Nov(?:ember)?\s*15|'
        r'11[/-]12[^\n]{0,40}11[/-]15)',
        content
    ))
    if matched_freshness >= 2 and has_day_gap:
        df_score = 1.0
    elif matched_freshness >= 2:
        df_score = 0.5
    elif matched_freshness >= 1:
        df_score = 0.25
    scores["data_freshness_reasoning"] = df_score

    # --- volume_anomaly_noted: Nov 12 volume spike identification ---
    vol_score = 0.0
    vol_patterns = [
        r'(?i)(?:volume|turnover)[^\n]{0,100}(?:spike|anomal|unusual|abnormal|surge|elevated|significant)',
        r'(?i)(?:spike|anomal|unusual|abnormal|surge)[^\n]{0,100}(?:volume|turnover)',
        r'(?i)(?:Nov(?:ember)?\s*12|11[/-]12)[^\n]{0,80}(?:volume|3[\.,]?1[0-9]\s*(?:M|million)|2[\.\s]*[4-8]\s*(?:x|times))',
        r'(?i)(?:volume|3[\.,]?1[0-9]\s*(?:M|million)|2[\.\s]*[4-8]\s*(?:x|times))[^\n]{0,80}(?:Nov(?:ember)?\s*12|11[/-]12)',
        r'(?i)\b(?:capitulat|institutional\s+reposit|accumulation|distribution)\b[^\n]{0,80}(?:volume|Nov(?:ember)?\s*12)',
    ]
    for pat in vol_patterns:
        if re.search(pat, content):
            vol_score = 1.0
            break
    if vol_score == 0.0 and re.search(r'(?i)(?:volume|turnover)[^\n]{0,60}(?:high|above|exceed|times|x\b|\d+\s*M)', content):
        vol_score = 0.5
    scores["volume_anomaly_noted"] = vol_score

    # --- expected_return_calculated: compute from signal history CSV ---
    ref_er = ref.get("exp_ret")
    if ref_er is not None:
        er_pats = [
            r'(?i)(?:expected|anticipat)\s+(?:return|gain|profit|value)[^\n]{0,80}?(\d+(?:\.\d+)?)\s*%',
            r'(?i)(\d+(?:\.\d+)?)\s*%[^\n]{0,80}?(?:expected|anticipat)\s+(?:return|gain|profit)',
            r'(?i)(?:EV|expected\s*value|E\[R\])[^\n]{0,60}?(\d+(?:\.\d+)?)\s*%',
        ]
        best_er = 0.0
        for pat in er_pats:
            for m in re.finditer(pat, content):
                try:
                    v = float(m.group(1))
                    if abs(v - ref_er) <= 0.2:
                        best_er = 1.0
                    elif abs(v - ref_er) <= 0.5:
                        best_er = max(best_er, 0.5)
                except ValueError:
                    pass
        if best_er < 1.0 and json_data:
            jv = jval(json_data, ["expectedreturn", "expectedgain", "expreturn", "expectedvalue"])
            if jv is not None:
                if abs(jv - ref_er) <= 0.2:
                    best_er = max(best_er, 1.0)
                elif abs(jv - ref_er) <= 0.5:
                    best_er = max(best_er, 0.5)
        scores["expected_return_calculated"] = best_er

    # --- risk_reward_ratio_calculated: compute from signal history CSV ---
    ref_rr = ref.get("rr")
    if ref_rr is not None:
        rr_pats = [
            r'(?i)(?:risk[\s/:-]*reward|R[\s/:-]*R|reward[\s/:-]*risk)\s*(?:ratio)?[^\n]{0,60}?(\d+(?:\.\d+)?)',
            r'(?i)(\d+(?:\.\d+)?)\s*(?::\s*1|to\s*1)[^\n]{0,40}(?:risk|reward|R/R)',
            r'(?i)(?:avg|average)\s+gain[^\n]{0,40}(?:avg|average)\s+loss[^\n]{0,40}(\d+(?:\.\d+)?)',
        ]
        best_rr = 0.0
        for pat in rr_pats:
            for m in re.finditer(pat, content):
                try:
                    v = float(m.group(1))
                    if abs(v - ref_rr) <= 0.2:
                        best_rr = 1.0
                    elif abs(v - ref_rr) <= 0.4:
                        best_rr = max(best_rr, 0.5)
                except ValueError:
                    pass
        if best_rr < 1.0 and json_data:
            jv = jval(json_data, ["riskrewardratio", "riskreward", "rrratio", "rewardriskratio"])
            if jv is not None:
                if abs(jv - ref_rr) <= 0.2:
                    best_rr = max(best_rr, 1.0)
                elif abs(jv - ref_rr) <= 0.4:
                    best_rr = max(best_rr, 0.5)
        scores["risk_reward_ratio_calculated"] = best_rr

    # --- max_position_with_constraints: JSON position_size_usd vs computed max ---
    ref_mp = ref.get("mp")
    if ref_mp is not None and json_data and isinstance(json_data, dict):
        jp = jval(json_data, ["positionsizeusd", "positionsize"])
        if jp is not None:
            if abs(jp - ref_mp) / ref_mp <= 0.15:
                scores["max_position_with_constraints"] = 1.0
            elif abs(jp - ref_mp) / ref_mp <= 0.30:
                scores["max_position_with_constraints"] = 0.5

    return scores
```

## LLM Judge Rubric

**Fallback Rule**: If `trading_decision.md` does not exist or is empty, all criteria below automatically score 0.0. If `risk_summary.json` is missing but `trading_decision.md` exists, deduct proportionally within each criterion where structured output quality is assessed.

### Criterion 1: Depth and Correctness of Trap Resolution Reasoning (Weight: 40%)
**Score 1.0**: The write-up explicitly explains *why* each data conflict was resolved the way it was. For the stale portfolio data, it cites the timestamp difference (Nov 12 vs Nov 15) and explains why recency matters, concluding $320,000 is the correct available cash. For the correlation mismatch, it explicitly notes that the matrix uses percentages while the risk parameters use decimals, shows the conversion (78 → 0.78 > 0.7), and explains the implication for the ABCD holding. For the alternative model, it identifies the deprecation notice (not just ignoring the signal, but explaining *where* and *why* it is deprecated — citing the metadata field showing deprecation date of 2024-09-01 and the note about being superseded by v3.2.1) and articulates why the primary model is authoritative despite having lower numerical confidence. All reasoning is grounded in actual file contents, not fabricated.
**Score 0.75**: Resolves all three traps correctly and provides reasoning for at least two of them, but one trap resolution lacks explicit justification (e.g., uses $320K correctly but doesn't clearly explain the timestamp-based reasoning, or dismisses the alternative model without citing the deprecation metadata).
**Score 0.5**: Resolves two of the three traps correctly with some reasoning, but one trap is either missed entirely or resolved incorrectly. For example, correctly handles the stale data and deprecated model but fails to convert correlation units properly (e.g., compares 78 directly to 0.7 threshold), or handles correlation but doesn't explain the stale data choice.
**Score 0.25**: Resolves only one trap correctly with reasoning. The other two are either ignored, resolved incorrectly, or resolved without any visible reasoning (appearing as lucky guesses). May show signs of confusion, such as averaging the two cash figures or blending the contradictory signals.
**Score 0.0**: Fails to correctly resolve any of the three traps, or the write-up shows no evidence of recognizing that data conflicts exist. Conclusions are based on stale, misinterpreted, or deprecated data without acknowledgment. A generic analysis that happens to use correct numbers without explaining why does not qualify.

### Criterion 2: Analytical Coherence and Quantitative Rigor (Weight: 35%)
**Score 1.0**: The recommendation reads as a cohesive, logically structured document where each section builds on the previous one. Constraints are shown to interact quantitatively: the 10% single-position cap ($125K), the sector exposure headroom of ~7% (~$87.5K), the correlation with ABCD (0.78 > 0.7 threshold), the elevated volatility (20d HV risen to ~0.39, IV rank ~73), and ideally the per-trade allocation limit (20% of available cash = $64K from trading_rules.yaml) all jointly constrain the position, and the write-up shows how these interact to arrive at a final position size. The risk_summary.json values are consistent with the narrative analysis. Historical win rate (~73% for MEDIUM confidence BUY signals) and expected risk/reward are correctly cited from the actual historical_signals_performance.csv data.
**Score 0.75**: The document is well-structured and the final recommendation follows from the analysis, but there is at least one logical gap — for example, constraints are listed individually but their interaction is not fully explored (e.g., the binding constraint among cash, position limit, and sector cap is not explicitly identified), or the risk_summary.json has minor inconsistencies with the narrative.
**Score 0.5**: The document covers the required topics but reads more like a checklist of independent sections than an integrated analysis. The final recommendation is broadly consistent with the data but the path from evidence to conclusion has notable gaps. Some constraints may be mentioned but not quantitatively applied to position sizing. Position size may be outside the reasonable range or lack justification.
**Score 0.25**: The document has significant logical inconsistencies — for example, the risk analysis flags high correlation and sector concentration but the recommendation ignores these factors, or the position size contradicts the constraints discussed. The risk_summary.json is missing or severely inconsistent with the narrative.
**Score 0.0**: The recommendation contradicts its own analysis, or the document lacks any discernible logical structure. Conclusions appear arbitrary or hallucinated rather than derived from the data discussed.

### Criterion 3: Professional Quality and Completeness of Presentation (Weight: 25%)
**Score 1.0**: The document is written at institutional trading desk quality: precise numerical references (specific prices, percentages, dollar amounts tied to source data with explicit file attribution — e.g., citing portfolio_status.json, risk_parameters.yaml, or historical_signals_performance.csv when making claims), appropriate use of financial terminology, clear section headers matching the requested structure. Includes actionable specifics: entry price range (~$51), stop-loss rationale tied to support level ($50.10) and signal suggestion ($49.50), position size in both dollars and shares with portfolio percentage, time horizon relative to economic calendar events. Caveats and conditions are stated (e.g., "contingent on no gap-down Monday," "reassess if Fed minutes shift rate expectations"). Both deliverables are produced and internally consistent.
**Score 0.75**: The document is professionally written with most quantitative details present, but lacks one or two elements — missing conditional triggers, vague on entry mechanics, no file/source attribution for key claims, or risk_summary.json is present but incomplete.
**Score 0.5**: The document is readable but more qualitative than quantitative. Uses general language ("the correlation is high," "position should be moderate") instead of precise figures. Some sections feel thin or boilerplate rather than tailored to the XYZT scenario. May be missing the risk_summary.json entirely.
**Score 0.25**: The document is incomplete, missing major requested sections, or reads as a rough draft. Key quantitative details are absent or clearly fabricated. Language is imprecise for a trading desk context.
**Score 0.0**: The document is severely incomplete, incoherent, or entirely generic with no connection to the specific data and scenario described. Would not be usable in any professional context.
