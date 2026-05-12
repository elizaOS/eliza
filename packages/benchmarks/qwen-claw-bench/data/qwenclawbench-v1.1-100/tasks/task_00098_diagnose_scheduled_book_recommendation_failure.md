---
id: task_00098_diagnose_scheduled_book_recommendation_failure
name: Diagnose Scheduled Book Recommendation Failure
category: Communication and Scheduling
subcategory: Reminders and Scheduled Tasks
grading_type: hybrid
grading_weights:
  automated: 0.5
  llm_judge: 0.5
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: config/messaging.yaml
  dest: config/messaging.yaml
- source: config/task_scheduler.yaml
  dest: config/task_scheduler.yaml
- source: data/books.json
  dest: data/books.json
- source: logs/book_recommendation.log
  dest: logs/book_recommendation.log
- source: scripts/send_book_recommendation.py
  dest: scripts/send_book_recommendation.py
- source: templates/book_recommendation.md
  dest: templates/book_recommendation.md
---
## Prompt

Yesterday's daily book recommendation message didn't go out. Nothing showed up in the group channel and even the admin failure alert didn't arrive. Can you investigate what went wrong and write up your findings in `diagnosis_report.md`? I also need a `book_recommendation.sh` in the workspace root that can be used to trigger the daily send going forward. If you can, create a skill to capture the diagnostic pattern for scheduled notification failures so we can reuse it next time.

## Expected Behavior

The agent should investigate the failure by reading the log file, configuration files, and the sending script — cross-referencing them to identify root causes and secondary issues that are not immediately obvious from any single file.

A meaningful diagnosis requires more than reading the log error message. The workspace contains several discrepancies and configuration issues that are only discoverable through systematic cross-file analysis: comparing log execution dates against the declared schedule, comparing the API's error response values against the retry configuration, examining whether the sending script actually enforces the rate-limit configuration declared in the messaging config, and cross-checking the books database state against the log history.

The agent should write a specific, grounded `diagnosis_report.md` that goes beyond restating the log output — it should name the relevant config values and script behaviors that contributed to or worsened the failure. The recommended remediation should be actionable and tied to the actual workspace configuration (for example, using the already-configured discord fallback, or correcting retry timing to respect the API's retry_after value).

A `book_recommendation.sh` script and optional `SKILL.md` should also be produced.

## Grading Criteria

- [ ] diagnosis_report_created: diagnosis_report.md created with meaningful content (>200 characters)
- [ ] telegram_429_root_cause_documented: report identifies the Telegram API 429 rate-limit error as the immediate failure cause
- [ ] retry_timing_mismatch_documented: report identifies that the configured retry delay (300 s) is far shorter than the API's required wait (retry_after=3600 s), making all retries futile
- [ ] execution_gap_pattern_analyzed: report analyzes the non-daily execution pattern visible in the logs, noting specific missing dates or a systematic gap description
- [ ] secondary_config_issues_identified: report or transcript identifies at least one secondary issue beyond the 429 error (timezone ambiguity in task_scheduler.yaml, rate_limit config not enforced by the script, or the script's send_message not making a real HTTP/API call)
- [ ] actionable_remediation_proposed: report proposes a specific remediation grounded in workspace data (activating discord fallback, correcting retry timing to respect retry_after, fixing timezone or cron configuration, or implementing rate_limit in the script)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    from pathlib import Path

    scores = {
        "diagnosis_report_created": 0.0,
        "telegram_429_root_cause_documented": 0.0,
        "retry_timing_mismatch_documented": 0.0,
        "execution_gap_pattern_analyzed": 0.0,
        "secondary_config_issues_identified": 0.0,
        "actionable_remediation_proposed": 0.0,
    }

    # Bail immediately on empty submissions
    has_response = False
    for event in transcript:
        if event.get("type") == "message":
            msg = event.get("message", {})
            if msg.get("role") == "assistant":
                has_response = True
                break
    if not has_response:
        return scores

    ws = Path(workspace_path)

    # --- Collect diagnosis_report.md content ---
    diag_path = ws / "diagnosis_report.md"
    report_text = ""
    if diag_path.exists():
        report_text = diag_path.read_text(errors="replace")

    report_lower = report_text.lower()

    # --- Collect all assistant transcript text ---
    assistant_text = ""
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content", "")
        if isinstance(content, str):
            assistant_text += " " + content
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    assistant_text += " " + block.get("text", "")
    tx_lower = assistant_text.lower()

    # 1. diagnosis_report_created
    if len(report_text.strip()) > 200:
        scores["diagnosis_report_created"] = 1.0
    elif len(report_text.strip()) > 80:
        scores["diagnosis_report_created"] = 0.5

    # 2. telegram_429_root_cause_documented
    # Must appear in the written report (not just transcript) to count fully
    if "429" in report_text:
        scores["telegram_429_root_cause_documented"] = 1.0
    elif any(kw in report_lower for kw in ["too many requests", "rate limit", "rate-limit"]):
        scores["telegram_429_root_cause_documented"] = 0.75
    elif "429" in tx_lower:
        scores["telegram_429_root_cause_documented"] = 0.4

    # 3. retry_timing_mismatch_documented
    # Requires the specific retry_after value (3600) to be mentioned alongside retry/delay context
    has_3600_in_report = "3600" in report_text
    has_retry_context = any(kw in report_lower for kw in [
        "retry_after", "retry after", "delay_seconds", "delay", "300"
    ])
    if has_3600_in_report and has_retry_context:
        scores["retry_timing_mismatch_documented"] = 1.0
    elif has_3600_in_report:
        scores["retry_timing_mismatch_documented"] = 0.6
    elif "3600" in tx_lower and any(kw in tx_lower for kw in ["retry", "delay", "300"]):
        scores["retry_timing_mismatch_documented"] = 0.4

    # 4. execution_gap_pattern_analyzed
    # Check for specific gap dates (2026-03-06, 03-07, 03-09, 03-11, 03-13, 03-16) in report
    gap_dates = ["03-06", "03-07", "03-09", "03-11", "03-13", "03-16",
                 "march 6", "march 7", "march 9", "march 11", "march 13"]
    specific_gap_in_report = any(d in report_lower for d in gap_dates)
    gap_pattern_in_report = any(kw in report_lower for kw in [
        "not daily", "not every day", "gap", "missing date", "irregular", "skipped", "inconsistent execution"
    ])
    if specific_gap_in_report:
        scores["execution_gap_pattern_analyzed"] = 1.0
    elif gap_pattern_in_report and any(kw in report_lower for kw in ["log", "execution", "cron", "run"]):
        scores["execution_gap_pattern_analyzed"] = 0.75
    elif any(d in tx_lower for d in gap_dates) or (
        any(kw in tx_lower for kw in ["not daily", "gap", "missing date", "irregular"]) and "log" in tx_lower
    ):
        scores["execution_gap_pattern_analyzed"] = 0.4

    # 5. secondary_config_issues_identified
    # Any one of: timezone ambiguity, rate_limit not enforced, script lacks real API call
    has_timezone = "asia/shanghai" in report_lower or (
        "timezone" in report_lower and any(kw in report_lower for kw in ["utc", "cst", "conflict", "ambig"])
    )
    has_rate_limit_bypass = any(kw in report_lower for kw in [
        "rate_limit", "rate limit"
    ]) and any(kw in report_lower for kw in [
        "not enforced", "not used", "ignored", "bypass", "not read", "not implemented"
    ])
    has_script_code_issue = any(kw in report_lower for kw in [
        "print(", "no api call", "does not call", "doesn't call", "placeholder", "not sending"
    ])
    if has_timezone or has_rate_limit_bypass or has_script_code_issue:
        scores["secondary_config_issues_identified"] = 1.0
    else:
        # Partial credit if found in transcript but not written to report
        tx_timezone = "asia/shanghai" in tx_lower and any(kw in tx_lower for kw in ["utc", "timezone", "ambig"])
        tx_rate_limit = "rate_limit" in tx_lower and any(kw in tx_lower for kw in ["not enforced", "bypass", "not used"])
        tx_script = any(kw in tx_lower for kw in ["print(", "no api call", "placeholder", "just print"])
        if tx_timezone or tx_rate_limit or tx_script:
            scores["secondary_config_issues_identified"] = 0.5

    # 6. actionable_remediation_proposed
    has_discord_fix = "discord" in report_lower and any(kw in report_lower for kw in [
        "fallback", "switch", "enable", "activate", "use discord", "configure"
    ])
    has_retry_fix = "3600" in report_lower and any(kw in report_lower for kw in [
        "wait", "sleep", "honor", "respect", "retry_after", "increase"
    ])
    has_cron_fix = any(kw in report_lower for kw in [
        "cron", "timezone", "schedule"
    ]) and any(kw in report_lower for kw in ["fix", "update", "correct", "change", "configure"])
    if has_discord_fix or has_retry_fix or has_cron_fix:
        scores["actionable_remediation_proposed"] = 1.0
    elif "discord" in report_lower or any(kw in report_lower for kw in ["fallback", "retry_after"]):
        scores["actionable_remediation_proposed"] = 0.6
    elif "discord" in tx_lower or "retry_after" in tx_lower:
        scores["actionable_remediation_proposed"] = 0.35

    return scores
```

## LLM Judge Rubric

### Incident Analysis Precision (Weight: 40%)

Evaluate whether the diagnosis accurately identifies the failure mechanism with specific values from the log and configuration files.

- **1.0**: Correctly identifies the Telegram 429 error, notes the specific `retry_after=3600` value from the log, explicitly compares it to the configured `delay_seconds=300`, and explains why all three retry attempts were guaranteed to fail (each waited only 5 minutes, far less than the 1-hour cooldown). Quantitative framing is present.
- **0.75**: Identifies 429 and retry timing mismatch but without citing both the 3600 and 300 values explicitly, or without explaining why the retries were futile rather than just delayed.
- **0.5**: Identifies the 429 error as the root cause but treats the retry configuration as correct or doesn't examine the delay mismatch.
- **0.25**: Mentions the failure and references "rate limiting" in general terms without engaging with the specific retry configuration.
- **0.0**: Does not identify the root cause, or only restates "the message failed to send" without analysis.

### Cross-File Systematic Analysis (Weight: 45%)

Evaluate whether the agent discovered issues that require cross-referencing multiple workspace files and are not immediately visible from the log alone.

- **1.0**: Identifies **at least two** of the following, each with specific file-sourced evidence: (a) execution gaps — log shows non-daily runs (e.g., 03-06, 03-07, 03-09 missing) which contradicts the daily cron schedule; (b) timezone ambiguity — `task_scheduler.yaml` sets `timezone: Asia/Shanghai` alongside a UTC cron expression, creating ambiguity about when the task actually runs; (c) rate_limit config not enforced — `messaging.yaml` declares `rate_limit: messages_per_second: 1` but `send_book_recommendation.py` never reads `messaging.yaml`; (d) script has no real API implementation — `send_message()` only calls `print()` and returns `True`, so any Telegram HTTP errors visible in the log originate from a different production execution path, not this script file.
- **0.75**: Identifies one non-obvious secondary issue with file-level evidence.
- **0.5**: Notes configuration concerns at a surface level (e.g., "the timezone may be wrong") without citing specific file evidence or values.
- **0.25**: Analysis stays entirely within the log file; no cross-file examination of config or script behavior.
- **0.0**: No systematic investigation; output is generic or fabricated without grounding in workspace files.

### Fix Quality and Grounding (Weight: 15%)

Evaluate whether the recommended remediations are specific and directly tied to workspace data.

- **1.0**: Proposes concrete fixes anchored to the workspace: e.g., activate the already-configured discord fallback (`fallback_channel: discord` in config), modify the retry logic to honor `retry_after` from the API response (not a fixed delay), and/or resolve the timezone ambiguity in `task_scheduler.yaml`. Each fix traces back to a specific file or value.
- **0.75**: Proposes reasonable fixes most of which are grounded; may lack one specific workspace anchor.
- **0.5**: Generic fixes (e.g., "increase retry delay", "check Telegram quota") without workspace-specific grounding.
- **0.25**: Vague recommendations or recommendations unrelated to the discovered issues.
- **0.0**: No actionable recommendations, or recommendations contradict the workspace evidence.
