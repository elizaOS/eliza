---
id: task_00068_enhanced_poly_arb_monitoring_script_execution
name: Enhanced Poly-Arb Monitoring Script Execution
category: Finance and Quantitative Trading
subcategory: Trading Systems and Engineering
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: scripts/poly-arb-monitor.sh
  dest: scripts/poly-arb-monitor.sh
- source: scripts/generate-tx-log.py
  dest: scripts/generate-tx-log.py
- source: config/arb-config.json
  dest: config/arb-config.json
- source: config/cron-jobs.yaml
  dest: config/cron-jobs.yaml
- source: logs/transactions.log
  dest: logs/transactions.log
---

## Prompt

[cron:a2ce4b5b-63bf-4235-a84d-5a66cf18532f poly-arb-monitor-enhanced] Run the enhanced monitoring script, check POL/USDC balances, and monitor the transaction logs. This run requires full anomaly detection: check every threshold defined in `config/arb-config.json`, flag any transactions that violate configured limits, and escalate critical issues.
Current time: Tuesday, February 10th, 2026 — 10:49 PM (Asia/Shanghai)

## Expected Behavior

The agent should:

1. **Discover and read the configuration**: Read `config/arb-config.json` fully, including `thresholds.max_pending_age_min: 30`, `thresholds.min_profit_usdc: 0.50`, `thresholds.max_slippage_bps: 50`, and `thresholds.pol_min_balance: 50` / `usdc_min_balance: 500`. Note `config/cron-jobs.yaml` links the cron ID to this job.

2. **Attempt to run the monitoring script**: Execute `scripts/poly-arb-monitor.sh`. If dependencies like `jq` or `bc` are missing, adapt by rewriting the logic in Python.

3. **Attempt balance queries via RPC** (`config/arb-config.json → rpc.primary`). Handle failures gracefully. Write `data/balance-cache.json` with at minimum: timestamp, wallet address, and balance information (or failure status if RPC is unreachable).

4. **Perform full transaction log analysis** on `logs/transactions.log` (85 entries, space-separated format). Compute:
   - Status counts: SUCCESS 63, FAILED 10, PENDING 12.
   - Failure reason breakdown: GAS_ESTIMATION_FAILED×5, DEADLINE_EXCEEDED×2, INSUFFICIENT_OUTPUT×2, NONCE_TOO_LOW×1.
   - High-slippage events (slippage_bps > 50): 36 transactions.
   - **Cross-day stale PENDING**: one PENDING entry has timestamp `2026-02-09T08:21:19Z` — from the previous day. This transaction has been pending for over 38 hours, far beyond any reasonable timeout, and must be flagged as a stuck/lost transaction requiring manual investigation.
   - **Additional stale PENDINGs**: the remaining 11 PENDING entries from 2026-02-10 that are older than `max_pending_age_min: 30` minutes relative to current time (22:49 CST = 14:49 UTC). Entries before 14:19 UTC (7 entries: 09:51, 10:06, 10:23, 12:00, 12:29, 13:13, and the yesterday entry) exceed this threshold.
   - **CRITICAL — NONCE_TOO_LOW**: one FAILED transaction has `reason=NONCE_TOO_LOW`. This is not a normal execution failure — it indicates the bot submitted a transaction with an already-used nonce, pointing to a crash/restart race condition or nonce tracking bug. This must be escalated as a **critical alert** requiring immediate investigation, distinct from ordinary failures.
   - **Sub-threshold profit violations**: 4 SUCCESS trades executed with profit below `min_profit_usdc: 0.50` (but not negative): +0.2485, +0.0707, +0.1728, +0.3420 USDC. These represent bot execution logic errors — the arb was taken despite not meeting the minimum profit threshold.
   - **Negative-profit SUCCESS trades**: 8 SUCCESS trades with negative profit: −0.0510, −0.2173, −0.1264, −0.3233, −0.2989, −0.4112, −0.4422, −0.2417 USDC. These are trades that were mined on-chain (SUCCESS) yet resulted in a net loss.
   - Per-pair breakdown of trade counts and aggregate profit for POL/USDC, POL/WETH, and WETH/USDC.

5. **Write output files**: Create `data/balance-cache.json` (required primary output). Optionally produce a report file summarizing findings.

6. **Produce a structured monitoring report** covering: balance status (with threshold alerts), transaction statistics, critical alerts (NONCE_TOO_LOW, cross-day stale PENDING), threshold violation summary, and recommended actions.

## Grading Criteria

- [ ] `data/balance-cache.json` exists and contains valid JSON with timestamp, wallet, and balance fields
- [ ] Monitoring report detects and escalates the NONCE_TOO_LOW failure as a critical issue
- [ ] Report identifies the cross-day stale PENDING (timestamp 2026-02-09) and at least 3 additional stale PENDINGs exceeding max_pending_age_min
- [ ] Report identifies the 4 sub-threshold-profit SUCCESS trades (profit > 0 but < min_profit_usdc: 0.50) and/or the 8 negative-profit SUCCESS trades
- [ ] Report includes per-pair profit/trade breakdown (POL/USDC, POL/WETH, WETH/USDC)
- [ ] Agent handled missing tools or RPC errors adaptively rather than failing silently

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json
    import re
    from pathlib import Path

    scores = {
        "balance_cache_written": 0.0,
        "nonce_error_flagged_critical": 0.0,
        "stale_pending_detected": 0.0,
        "threshold_violations_reported": 0.0,
        "per_pair_breakdown_present": 0.0,
    }

    ws = Path(workspace_path)

    # Early return if primary output is missing
    balance_cache_path = ws / "data" / "balance-cache.json"
    if not balance_cache_path.exists():
        return scores

    # 1. Balance cache: valid JSON with required fields
    try:
        cache_data = json.loads(balance_cache_path.read_text(encoding="utf-8", errors="ignore"))
        if isinstance(cache_data, dict):
            has_ts = any(k in cache_data for k in ["timestamp", "time", "checked_at", "date"])
            has_wallet = any(k in cache_data for k in ["wallet", "wallet_address", "address"])
            has_balance = any(
                "balance" in k.lower() or "pol" in k.lower() or "usdc" in k.lower()
                for k in cache_data.keys()
            )
            field_score = sum([0.34 * has_ts, 0.33 * has_wallet, 0.33 * has_balance])
            scores["balance_cache_written"] = round(field_score, 2)
            if not (has_ts or has_wallet or has_balance):
                scores["balance_cache_written"] = 0.2  # file exists but no key fields
    except Exception:
        scores["balance_cache_written"] = 0.1

    # Build full text from transcript + any report files
    full_text = ""
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            full_text += str(msg.get("content", "")) + "\n"
    for report_glob in ["data/*.json", "data/*.md", "data/*.txt", "*.md", "*.txt"]:
        for f in ws.glob(report_glob):
            if f.name == "balance-cache.json":
                continue
            try:
                full_text += f.read_text(encoding="utf-8", errors="ignore") + "\n"
            except Exception:
                pass
    text_lower = full_text.lower()

    # 2. NONCE_TOO_LOW flagged as critical (not just mentioned)
    has_nonce = "nonce" in text_lower
    is_critical = any(kw in text_lower for kw in ["critical", "urgent", "immediate", "escalat", "investigate", "bug", "crash"])
    if has_nonce and is_critical:
        scores["nonce_error_flagged_critical"] = 1.0
    elif has_nonce:
        scores["nonce_error_flagged_critical"] = 0.4

    # 3. Stale PENDING detection
    has_stale_word = any(kw in text_lower for kw in ["stale", "stuck", "expired", "overdue", "pending", "lost"])
    has_yesterday = "2026-02-09" in full_text or "yesterday" in text_lower or "38 hour" in text_lower or "cross-day" in text_lower
    pending_count_signals = sum([
        "2026-02-09t08:21" in text_lower or "2026-02-09" in full_text,
        bool(re.search(r'(?i)(stale|stuck|expired).{0,80}pending|pending.{0,80}(stale|stuck|expired)', full_text)),
        bool(re.search(r'\b(7|8|9|10|11|12)\s*(stale|stuck|expired|pending)', text_lower)),
        "max_pending_age" in text_lower or "30 min" in text_lower,
    ])
    if has_yesterday and has_stale_word:
        scores["stale_pending_detected"] = 1.0
    elif has_yesterday or pending_count_signals >= 2:
        scores["stale_pending_detected"] = 0.7
    elif has_stale_word or pending_count_signals >= 1:
        scores["stale_pending_detected"] = 0.4

    # 4. Threshold violations: sub-threshold profits and/or negative-profit successes
    sub_threshold_signals = 0
    # Check for specific below-threshold profit values
    for val in ["0.2485", "0.0707", "0.1728", "0.3420"]:
        if val in full_text:
            sub_threshold_signals += 1
    # Check for mentions of below-threshold concept
    if re.search(r'(?i)(below.{0,30}threshold|below.{0,30}min|sub.?threshold|below.{0,30}profit)', full_text):
        sub_threshold_signals += 1
    # Check for negative-profit detection
    neg_profit_signals = sum(1 for v in ["-0.051", "-0.217", "-0.126", "-0.323", "-0.298", "-0.411", "-0.442", "-0.241"] if v in full_text)
    has_neg_concept = bool(re.search(r'(?i)(negative.{0,30}profit|loss.{0,30}success|success.{0,30}(loss|negative))', full_text))
    if sub_threshold_signals >= 2 or neg_profit_signals >= 3 or (sub_threshold_signals >= 1 and has_neg_concept):
        scores["threshold_violations_reported"] = 1.0
    elif sub_threshold_signals >= 1 or neg_profit_signals >= 1 or has_neg_concept:
        scores["threshold_violations_reported"] = 0.5

    # 5. Per-pair breakdown
    pairs_mentioned = sum([
        "pol/usdc" in text_lower or "pol_usdc" in text_lower,
        "pol/weth" in text_lower or "pol_weth" in text_lower,
        "weth/usdc" in text_lower or "weth_usdc" in text_lower,
    ])
    has_numbers_per_pair = bool(re.search(
        r'(?i)(pol.{0,10}usdc|pol.{0,10}weth|weth.{0,10}usdc).{0,60}\d+', full_text
    ))
    if pairs_mentioned >= 3 and has_numbers_per_pair:
        scores["per_pair_breakdown_present"] = 1.0
    elif pairs_mentioned >= 2 and has_numbers_per_pair:
        scores["per_pair_breakdown_present"] = 0.6
    elif pairs_mentioned >= 2:
        scores["per_pair_breakdown_present"] = 0.3

    return scores
```

## LLM Judge Rubric

### Threshold and Anomaly Detection (Weight: 30%)
- 1.0: Correctly detects all critical anomalies using `config/arb-config.json` thresholds: (1) cross-day stale PENDING from 2026-02-09 (38+ hours, clearly stuck); (2) ≥6 additional stale PENDINGs exceeding `max_pending_age_min: 30`; (3) NONCE_TOO_LOW explicitly escalated as critical, with explanation that it indicates a nonce-tracking bug; (4) 4 sub-threshold-profit SUCCESS trades (profits 0.07–0.34 USDC, below `min_profit_usdc: 0.50`).
- 0.75: Detects 3 of the 4 anomaly categories with supporting evidence.
- 0.5: Detects 2 anomaly categories, or mentions stale PENDINGs and NONCE_TOO_LOW but without distinguishing severity or referencing config thresholds.
- 0.25: Flags only one anomaly or mentions issues only in passing without quantitative detail.
- 0.0: No anomaly detection or threshold comparison performed.

### Transaction Log Analysis Quality (Weight: 25%)
- 1.0: Reports all metrics from `logs/transactions.log`: SUCCESS/FAILED/PENDING counts (63/10/12), complete failure reason breakdown (GAS_ESTIMATION_FAILED×5, DEADLINE_EXCEEDED×2, INSUFFICIENT_OUTPUT×2, NONCE_TOO_LOW×1), 36 high-slippage events (>50 bps), 8 negative-profit SUCCESS trades, and per-pair trade counts and aggregate profit for all 3 pairs.
- 0.75: Provides most metrics with at most one omission; per-pair breakdown attempted with minor errors.
- 0.5: Counts status totals and failure reasons correctly but omits negative-profit analysis or per-pair breakdown.
- 0.25: Reads the log and provides partial counts but misses failure reasons or slippage analysis.
- 0.0: Does not analyze the log, or produces fabricated data unrelated to actual log content.

### Critical Alert Escalation (Weight: 20%)
- 1.0: Clearly distinguishes between normal failures (GAS_ESTIMATION_FAILED, DEADLINE_EXCEEDED, INSUFFICIENT_OUTPUT) and the critical NONCE_TOO_LOW failure. Explains that NONCE_TOO_LOW indicates a bot crash/restart race condition or nonce management bug, and recommends specific remediation (inspect bot restart logic, check nonce sync mechanism, halt new trades until resolved).
- 0.75: Flags NONCE_TOO_LOW as more serious than other failures and recommends investigation, but explanation of root cause is vague.
- 0.5: Mentions NONCE_TOO_LOW but treats it equivalently to other failures without escalation.
- 0.25: Lists failure reasons including NONCE_TOO_LOW but provides no analysis of its severity.
- 0.0: Does not identify NONCE_TOO_LOW or fails to mention it at all.

### Adaptive Problem Solving (Weight: 15%)
- 1.0: When `jq`/`bc` are unavailable and RPC calls fail, the agent successfully rewrites the monitoring logic in Python (or another available approach), explains the workaround, and still produces all required outputs.
- 0.75: Adapts to at least one obstacle with a working fallback; minor gaps in the workaround.
- 0.5: Acknowledges tool/RPC issues but only partially adapts — some analysis is skipped rather than worked around.
- 0.25: Attempts to run the shell script but fails without meaningful fallback; output is incomplete.
- 0.0: No attempt to adapt; silently fails or ignores missing dependencies.

### Evidence Grounding and Report Quality (Weight: 10%)
- 1.0: All findings are directly referenced to actual workspace values (wallet address from config, specific tx hashes or timestamps from log, threshold values from config). `data/balance-cache.json` written with all required fields. Report is well-structured.
- 0.75: Most findings grounded in workspace data with minor unsupported claims.
- 0.5: Mix of real data and generic boilerplate; balance cache created but incomplete.
- 0.25: Minimal connection to actual workspace files; largely generic output.
- 0.0: No evidence of reading workspace files; balance cache missing or empty.
