---
id: task_00072_spark_fi_liquidity_monitor_delta_analysis_and_alert_report
name: Spark.fi Liquidity Monitor Delta Analysis and Alert Report
category: Workflow and Agent Orchestration
subcategory: Script and Terminal Automation
difficulty: hard
grading_type: hybrid
grading_weights: {automated: 0.4, llm_judge: 0.6}
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
  - source: spark-monitor/config.yaml
    dest: spark-monitor/config.yaml
  - source: spark-monitor/data/snapshots/snapshot_2026-02-10T09-16-00Z.json
    dest: spark-monitor/data/snapshots/snapshot_2026-02-10T09-16-00Z.json
  - source: spark-monitor/data/snapshots/snapshot_2026-02-10T10-16-00Z.json
    dest: spark-monitor/data/snapshots/snapshot_2026-02-10T10-16-00Z.json
  - source: spark-monitor/logs/spark-monitor.log
    dest: spark-monitor/logs/spark-monitor.log
skill_creation: false
---

## Prompt

The spark liquidity monitor cron has been stalled for the past hour — the logs show RPC failures starting around 18:46 (Shanghai). Can you run it manually, pull fresh data for all configured markets (Ethereum + Gnosis), compare against the last good snapshot to catch any threshold violations, and drop a full alert report in `spark-monitor/data/reports/alert_20260210_1916.md`? For each breach, include the asset name, the specific threshold crossed, the current measured value, and how much it changed since the previous snapshot. Also make sure the monitoring script (`spark-monitor/monitor.py` or `spark-monitor/monitor.js`) properly handles per-asset thresholds and delta-based alerts going forward.

Current time: Tuesday, February 10th, 2026 — 7:16 PM (Asia/Shanghai)

## Expected Behavior

The agent should:

1. Read `spark-monitor/logs/spark-monitor.log` to diagnose the failure. The log shows the primary Ethereum RPC has been returning HTTP 401 (ALCHEMY_API_KEY not configured), and the fallback RPC has been rate-limited since run #8434 (10:21 UTC). Gnosis chain RPCs have been unreachable since before the monitoring period started.

2. Read `spark-monitor/config.yaml` and extract per-asset thresholds for all 8 monitored assets, including each asset's individual `utilization_ceiling` and `liquidity_floor_usd`. Critically, these thresholds differ per asset (e.g., WETH ceiling=0.85, wstETH ceiling=0.80, USDC ceiling=0.90, rETH ceiling=0.75), and must not be conflated with each other or with global thresholds.

3. Load both historical snapshots (`snapshot_2026-02-10T09-16-00Z.json` as T-2h baseline and `snapshot_2026-02-10T10-16-00Z.json` as T-1h last-known state). Attempt to fetch fresh on-chain data; if all configured RPCs remain unavailable, acknowledge the freshness limitation and proceed with T-1h as the working dataset, noting that values may be up to ~1 hour stale.

4. Perform cross-snapshot delta analysis by comparing T-1h values against T-2h values. The monitoring script at run #8433 only detected 2 alerts (USDC utilization ceiling and sUSDS APY floor), but there are at least 8 distinct threshold breaches that a correct delta-aware analysis should identify:

   - **USDC** — utilization 0.941 exceeds per-asset ceiling 0.900 (already in snapshot alerts)
   - **USDC** — available liquidity $41.3M is below per-asset floor $100M
   - **USDC** — available liquidity dropped 62.4% in 1 hour ($109.9M → $41.3M), exceeding the 15% alert threshold
   - **wstETH** — available liquidity dropped 17.0% in 1 hour ($398.4M → $330.9M), exceeding the 15% alert threshold (utilization is only 0.336, below the 0.80 ceiling — agents relying solely on utilization will miss this)
   - **DAI** — borrow APY spiked 262 bps in 1 hour (5.20% → 7.82%), exceeding the 200 bps alert threshold
   - **rETH** — utilization 0.763 exceeds per-asset ceiling 0.750
   - **rETH** — available liquidity $14.2M is below per-asset floor $15M
   - **sUSDS** — savings APY 2.80% is below the 3.00% floor (already in snapshot alerts)

5. Note that Gnosis chain monitoring has been unavailable since before run #8421 (both RPCs unreachable). The sUSDC savings vault address is `0x000...` (not yet deployed) and should be skipped without error.

6. Write the alert report to `spark-monitor/data/reports/alert_20260210_1916.md`. The report must include for each breach: asset name, breach type, current measured value, the specific threshold from config that was violated, and the delta versus the previous snapshot. The report should also note the Gnosis chain gap and data staleness.

7. Create or update `spark-monitor/monitor.py` (or `.js`) with a corrected implementation that loads the previous snapshot for comparison, applies per-asset thresholds from config, computes percent changes in available liquidity and bps changes in borrow rates, and raises alerts for all threshold types.

## Grading Criteria

- [ ] Alert report file exists at `spark-monitor/data/reports/alert_20260210_1916.md`
- [ ] Report correctly identifies wstETH available liquidity drop breach (~17% drop, threshold 15%)
- [ ] Report correctly identifies DAI borrow rate spike breach (~262 bps, threshold 200 bps)
- [ ] Report correctly identifies rETH utilization and/or liquidity floor breach (util 0.763 vs ceiling 0.750, or avail $14.2M vs floor $15M)
- [ ] Report correctly identifies USDC breaches with specific values (not just "USDC flagged")
- [ ] Monitoring script exists with delta comparison logic and per-asset threshold handling
- [ ] Agent correctly notes that Gnosis chain data is unavailable

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import re
    from pathlib import Path

    scores = {
        "alert_report_exists": 0.0,
        "breach_usdc_detected": 0.0,
        "breach_wsteth_liquidity_drop_detected": 0.0,
        "breach_dai_borrow_spike_detected": 0.0,
        "breach_reth_detected": 0.0,
        "monitoring_script_with_delta_logic": 0.0,
        "gnosis_gap_noted": 0.0,
    }

    ws = Path(workspace_path)
    monitor_dir = ws / "spark-monitor"
    if not monitor_dir.exists():
        return scores

    # Collect text from report files and transcript
    all_text = ""

    reports_dir = monitor_dir / "data" / "reports"
    target_report = reports_dir / "alert_20260210_1916.md"
    if reports_dir.exists():
        # Prefer the specifically-required filename; fall back to any report file
        if target_report.exists() and target_report.stat().st_size > 50:
            try:
                all_text += target_report.read_text(encoding="utf-8", errors="replace") + "\n"
                scores["alert_report_exists"] = 1.0
            except Exception:
                pass
        else:
            for f in sorted(reports_dir.iterdir(), key=lambda x: x.stat().st_mtime):
                if f.suffix in [".md", ".txt", ".json"] and f.stat().st_size > 50:
                    try:
                        all_text += f.read_text(encoding="utf-8", errors="replace") + "\n"
                        scores["alert_report_exists"] = 0.7  # wrong filename, partial credit
                    except Exception:
                        pass
                    break

    if not all_text:
        for event in transcript:
            if event.get("type") == "message":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    content = str(msg.get("content", ""))
                    if len(content) > 300:
                        all_text += content + "\n"
        if any(kw in all_text.lower() for kw in ["usdc", "wsteth", "dai", "reth", "spark"]):
            scores["alert_report_exists"] = 0.3

    t = all_text.lower()

    # USDC breaches: utilization ceiling AND liquidity floor
    usdc_score = 0.0
    if "usdc" in t:
        has_util_breach = bool(re.search(r"0\.9[34]\d|util.*0\.94|0\.94.*util|util.*ceil|ceil.*breach|exceed.*ceil|ceil.*exceed", t))
        has_floor_breach = bool(re.search(r"41[.,][0-9]|41\.3|floor.*breach|below.*floor|floor.*below|below.*100\s*m|100m.*floor|liquidity.*floor.*usdc|usdc.*liquidity.*floor", t))
        has_drop_pct = bool(re.search(r"62[.,][0-9]\s*%|62\s*%|usdc.*drop|drop.*usdc", t))
        if has_util_breach and (has_floor_breach or has_drop_pct):
            usdc_score = 1.0
        elif has_util_breach:
            usdc_score = 0.5
        elif has_floor_breach or has_drop_pct:
            usdc_score = 0.4
        elif re.search(r"usdc.*breach|usdc.*alert|breach.*usdc", t):
            usdc_score = 0.2
    scores["breach_usdc_detected"] = usdc_score

    # wstETH available liquidity drop ~17% (cross-snapshot, requires delta computation)
    wsteth_score = 0.0
    if "wsteth" in t:
        has_drop_pct = bool(re.search(r"1[67][.,]\d+\s*%|17\s*%|16\s*%|17\.0|16\.9", t))
        has_liquidity_context = bool(re.search(r"wsteth.{0,80}(drop|declin|liquid|availab)|( drop|declin|liquid|availab).{0,80}wsteth", t))
        if has_drop_pct and has_liquidity_context:
            wsteth_score = 1.0
        elif has_drop_pct:
            wsteth_score = 0.6
        elif has_liquidity_context and re.search(r"wsteth.*alert|alert.*wsteth|wsteth.*breach|breach.*wsteth|wsteth.*threshold", t):
            wsteth_score = 0.4
    scores["breach_wsteth_liquidity_drop_detected"] = wsteth_score

    # DAI borrow rate spike ~262 bps (cross-snapshot, requires delta computation)
    dai_score = 0.0
    if "dai" in t:
        has_bps = bool(re.search(r"2[56]\d\s*bps|26[0-9]\s*bps|bps.*dai|dai.*bps", t))
        has_rate_context = bool(re.search(r"dai.{0,100}borrow.{0,60}(rate|apy|spike)|borrow.{0,60}(rate|apy|spike).{0,100}dai|dai.{0,60}spike|spike.{0,60}dai", t))
        if has_bps and has_rate_context:
            dai_score = 1.0
        elif has_bps:
            dai_score = 0.6
        elif has_rate_context and re.search(r"dai.*breach|breach.*dai|dai.*alert|alert.*dai", t):
            dai_score = 0.3
    scores["breach_dai_borrow_spike_detected"] = dai_score

    # rETH breaches: utilization ceiling 0.75 and/or liquidity floor $15M
    reth_score = 0.0
    if "reth" in t:
        has_util_breach = bool(re.search(r"0\.76[0-9]|reth.*0\.75|0\.75.*reth|reth.*ceil|ceil.*reth|util.*reth.*breach|reth.*util.*breach", t))
        has_floor_breach = bool(re.search(r"14[.,][0-9].*m|14\.2|reth.*floor|floor.*reth|below.*15\s*m|15m.*floor|reth.*liquid.*floor", t))
        if has_util_breach and has_floor_breach:
            reth_score = 1.0
        elif has_util_breach or has_floor_breach:
            reth_score = 0.6
        elif re.search(r"reth.*breach|breach.*reth|reth.*alert|alert.*reth", t):
            reth_score = 0.3
    scores["breach_reth_detected"] = reth_score

    # Monitoring script with delta analysis and per-asset threshold logic
    script_score = 0.0
    script_files = []
    for ext in ["*.py", "*.js"]:
        script_files.extend(monitor_dir.rglob(ext))
    for sp in script_files:
        try:
            sc = sp.read_text(encoding="utf-8", errors="replace").lower()
            delta_kws = ["delta", "prev", "previous", "compare", "change_pct", "drop_pct", "bps", "diff", "baseline", "last_snapshot"]
            threshold_kws = ["utilization_ceiling", "liquidity_floor", "per_asset", "asset_config", "ceiling"]
            d_count = sum(1 for k in delta_kws if k in sc)
            t_count = sum(1 for k in threshold_kws if k in sc)
            # Both delta and per-asset threshold are required for full credit
            if d_count >= 3 and t_count >= 2:
                local_score = 1.0
            elif d_count >= 2 and t_count >= 1:
                local_score = 0.7
            elif d_count >= 1 and t_count >= 1:
                local_score = 0.4
            else:
                local_score = min(d_count * 0.1 + t_count * 0.15, 0.3)
            script_score = max(script_score, local_score)
        except Exception:
            pass
    scores["monitoring_script_with_delta_logic"] = script_score

    # Gnosis chain gap noted
    gnosis_score = 0.0
    if re.search(r"gnosis.{0,60}(unavailable|skip|unreachable|timeout|failed|down|gap|missing)", t):
        gnosis_score = 1.0
    elif "gnosis" in t:
        gnosis_score = 0.5
    scores["gnosis_gap_noted"] = gnosis_score

    return scores
```

## LLM Judge Rubric

### Breadth and Accuracy of Anomaly Detection (Weight: 30%)
- 1.0: All 8 distinct threshold breaches correctly identified with specific measured values and the exact per-asset threshold from config that was violated. Both previously-caught alerts (USDC util, sUSDS APY) and all 6 missed alerts (USDC floor, USDC drop, wstETH drop, DAI bps, rETH util, rETH floor) are present.
- 0.75: 5–7 breaches identified correctly with specific values. May be missing one or two of the delta-dependent breaches (wstETH drop or DAI bps).
- 0.5: 3–4 breaches identified. Likely covers USDC utilization and sUSDS APY (from the snapshot's alerts field) but misses most delta-dependent or per-asset floor checks.
- 0.25: Only the 2 pre-flagged alerts from the snapshot JSON are reported, with no independent analysis. No evidence of delta computation or per-asset threshold logic.
- 0.0: No threshold breaches identified, or only generic commentary without specific values.

### Cross-Snapshot Delta Analysis Quality (Weight: 25%)
- 1.0: Numerically correct deltas computed for all relevant assets: wstETH available liquidity drop 16.9–17.1%, DAI borrow rate spike ~262 bps, USDC available liquidity drop ~62.4%. Per-asset thresholds (not global values) are applied throughout.
- 0.75: Delta computations attempted for most assets; values are approximately correct (within 2–3 percentage points or 20 bps). Minor errors in one asset's delta.
- 0.5: Delta analysis attempted but uses a single global threshold (e.g., a generic 90% ceiling for all assets) rather than per-asset thresholds from config. Some deltas computed correctly.
- 0.25: Mentions that values "changed" between snapshots but provides no quantitative delta or threshold comparison.
- 0.0: No cross-snapshot comparison performed. Treats T-1h snapshot in isolation or just reads the pre-computed alerts field.

### Config Fidelity and Per-Asset Threshold Application (Weight: 20%)
- 1.0: All per-asset thresholds from config.yaml correctly extracted and applied: WETH ceiling=0.85, wstETH ceiling=0.80, USDC ceiling=0.90 and floor=$100M, USDS ceiling=0.90, DAI ceiling=0.90, rETH ceiling=0.75 and floor=$15M, cbBTC ceiling=0.80, weETH ceiling=0.75. Savings APY floor of 3% applied. sUSDC correctly noted as not yet deployed.
- 0.75: Most per-asset thresholds correctly applied. May use a uniform global threshold for one or two assets or miss one floor value.
- 0.5: Per-asset ceilings roughly applied but liquidity floor values largely ignored. sUSDC may be incorrectly queried.
- 0.25: Single global threshold used for all utilization checks; floor values not applied.
- 0.0: Config not read or thresholds entirely fabricated.

### Alert Report Structure and Completeness (Weight: 15%)
- 1.0: Report saved to the correct path `spark-monitor/data/reports/alert_20260210_1916.md` (or equivalent). For every breach: asset name, breach type (utilization/floor/drop/rate), measured value, threshold value, and delta vs previous snapshot are all present. Report notes Gnosis chain unavailability and data staleness.
- 0.75: Report exists with most required fields. Missing delta for 1–2 breaches, or missing Gnosis/staleness note.
- 0.5: Report exists and covers most breaches but is missing multiple required fields (e.g., no threshold values, no deltas).
- 0.25: Report exists but is incomplete or vague — lists asset names without specific values.
- 0.0: No report file saved to the expected path.

### Monitoring Script Quality (Weight: 10%)
- 1.0: Script correctly implements: loading previous snapshot for comparison, per-asset threshold extraction from config.yaml, available liquidity % change computation, borrow rate bps change computation, and separate alert conditions for utilization ceiling, liquidity floor, liquidity drop %, and borrow rate spike. Gracefully handles missing Gnosis RPCs and undeployed sUSDC vault.
- 0.75: Script covers most required logic but has minor gaps (e.g., missing one alert type or does not handle sUSDC skip).
- 0.5: Script exists with some delta or per-asset logic, but significant gaps remain (e.g., no floor checks, or no bps computation).
- 0.25: Script exists but only checks current-snapshot utilization against a single global threshold.
- 0.0: No monitoring script created or updated.
