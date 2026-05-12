---
id: task_00032_gateway_health_check_skill_and_crash_pattern_analysis
name: Gateway Health Check Skill and Crash Pattern Analysis
category: System Operations and Administration
subcategory: System Operations and Monitoring
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: config/backup.yaml
  dest: config/backup.yaml
- source: config/gateway.conf
  dest: config/gateway.conf
- source: config/plugins.yaml
  dest: config/plugins.yaml
- source: logs/gateway-status.json
  dest: logs/gateway-status.json
- source: logs/gateway.log
  dest: logs/gateway.log
- source: logs/health-check.log
  dest: logs/health-check.log
- source: scripts/health-check.sh
  dest: scripts/health-check.sh
- source: scripts/restart-gateway.sh
  dest: scripts/restart-gateway.sh
- source: scripts/rotate-logs.sh
  dest: scripts/rotate-logs.sh
- source: systemd/openclaw-gateway.service
  dest: systemd/openclaw-gateway.service
---

## Prompt

My OpenClaw gateway has been crashing repeatedly. There are config files in `config/`, logs in `logs/`, restart scripts in `scripts/`, and a systemd unit in `systemd/`. The `logs/gateway-status.json` shows the gateway is currently marked healthy after a recent restart, but the crash history worries me.

Can you first create a reusable gateway health monitoring skill and save it to `workspace/skills/gateway-health/SKILL.md`? The skill should describe how to diagnose *recurring* gateway failures — what to look for in the logs, how to distinguish one-off crashes from systemic problems, and what monitoring signals to set up proactively. Then analyze the logs to figure out what's actually causing the crashes, and write your findings to `health_report.json`. Include current status, a crash pattern analysis with root cause, and concrete recommendations. Also update `HEARTBEAT.md` with the current gateway status and key findings.

Current time: Tuesday, February 10th, 2026 — 03:22 (Asia/Shanghai, UTC+8)

## Expected Behavior

The agent must read and cross-reference five files — `logs/gateway.log`, `logs/health-check.log`, `logs/gateway-status.json`, `config/gateway.conf`, and `systemd/openclaw-gateway.service` — to surface the crash pattern.

**Key findings from log analysis:**

1. **First crash (2026-02-09 16:00 CST):** `logs/gateway.log` shows memory at 847MB/1024MB at 15:59:58, then `Out of memory — process terminating` (exit code 137) at 16:00:00. The health-check recovered the gateway in one restart attempt.

2. **Second crash (2026-02-10 03:00 CST):** `logs/gateway.log` shows event loop lag warnings at 02:55 (2341ms) and 02:58 (4102ms), then health endpoint timeout at 02:59:55, process hung at 03:00:00. The health-check required **two** restart attempts (port 3578 still in use on first attempt, cleared on second).

3. **Root cause:** Memory pressure → event loop saturation → health endpoint unresponsive → process hung. Both crashes share the same underlying memory exhaustion pattern. The `gateway-status.json` confirms `total_restarts_24h: 2` and `consecutive_healthy: 1` (only one consecutive healthy check — fragile state).

4. **Current status:** Gateway healthy as of 03:02:09 CST (20 minutes before current time of 03:22); next scheduled health check at 03:30. Uptime is ~20 minutes — risk of another crash remains high.

5. **Trap — backup.yaml is a distractor:** `config/backup.yaml` explicitly states it is not related to health checks; agent should correctly identify it as irrelevant to the crash analysis.

**Expected `health_report.json`:**
```json
{
  "report_time": "2026-02-10T03:22:00+08:00",
  "current_status": "healthy",
  "last_health_check": "2026-02-10T03:02:09+08:00",
  "gateway_version": "1.4.2",
  "restarts_24h": 2,
  "consecutive_healthy_checks": 1,
  "risk_level": "high",
  "crash_pattern": {
    "crash_1": {
      "time": "2026-02-09T16:00:00+08:00",
      "cause": "OOM kill (exit code 137) — memory at 847MB/1024MB limit"
    },
    "crash_2": {
      "time": "2026-02-10T03:00:00+08:00",
      "cause": "Process hung — event loop lag 2341ms then 4102ms before health endpoint timeout"
    }
  },
  "root_cause": "Memory pressure leading to event loop saturation and eventual process failure",
  "recommendations": [
    "Increase memory limit above 1024MB or add OS-level swap",
    "Add proactive memory usage alerting at 75% threshold",
    "Monitor event loop lag as early warning signal before full crash"
  ]
}
```

**SKILL.md** must be at `workspace/skills/gateway-health/SKILL.md` (not at the workspace root). It should cover: how to read and correlate gateway and health-check logs, how to identify memory-driven crash patterns (OOM, event loop lag), and how to set up proactive monitoring signals.

**HEARTBEAT.md** must reference specific findings from the logs (e.g., port 3578, 2 restarts in 24h, consecutive_healthy count, or the memory crash at 847MB/1024MB).

## Grading Criteria

- [ ] SKILL.md exists at workspace/skills/gateway-health/SKILL.md with YAML frontmatter and proactive monitoring content
- [ ] health_report.json exists and is valid JSON
- [ ] health_report.json correctly identifies both crashes with memory/OOM root cause
- [ ] health_report.json includes restarts_24h: 2 and consecutive_healthy: 1 (or equivalent)
- [ ] HEARTBEAT.md references specific log data (not generic boilerplate)
- [ ] backup.yaml correctly identified as unrelated to the crash analysis (or ignored)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json
    import re

    scores = {
        "skill_md_quality": 0.0,
        "health_report_exists": 0.0,
        "root_cause_identified": 0.0,
        "trend_data_accurate": 0.0,
        "heartbeat_grounded": 0.0,
    }

    # SKILL.md must be at workspace/skills/gateway-health/SKILL.md
    skill_path = os.path.join(workspace_path, "workspace", "skills", "gateway-health", "SKILL.md")
    if os.path.isfile(skill_path):
        try:
            content = open(skill_path, "r", encoding="utf-8").read()
            has_frontmatter = content.strip().startswith("---")
            has_name = "name:" in content
            has_desc = "description:" in content.lower()
            has_sections = content.count("#") >= 3
            proactive_keywords = ["memory", "event loop", "pattern", "proactive", "alert", "trend", "warn"]
            has_proactive = sum(1 for k in proactive_keywords if k in content.lower()) >= 2
            if has_frontmatter and has_name and has_desc and has_sections and has_proactive:
                scores["skill_md_quality"] = 1.0
            elif has_frontmatter and (has_name or has_desc) and has_sections:
                scores["skill_md_quality"] = 0.6
            elif os.path.getsize(skill_path) > 100:
                scores["skill_md_quality"] = 0.3
        except Exception:
            scores["skill_md_quality"] = 0.1
    else:
        alt = os.path.join(workspace_path, "SKILL.md")
        if os.path.isfile(alt):
            scores["skill_md_quality"] = 0.2

    # health_report.json
    report_path = os.path.join(workspace_path, "health_report.json")
    if not os.path.isfile(report_path):
        return scores

    try:
        with open(report_path, "r", encoding="utf-8") as f:
            report = json.load(f)
        scores["health_report_exists"] = 1.0
        report_str = json.dumps(report).lower()
    except Exception:
        scores["health_report_exists"] = 0.3
        return scores

    # Root cause: must mention memory/OOM in context of crashes
    oom_keywords = ["memory", "oom", "out of memory", "137", "847", "1024", "event loop", "lag"]
    crash_keywords = ["crash", "hung", "restart", "failure", "cause", "root"]
    oom_hits = sum(1 for k in oom_keywords if k in report_str)
    crash_hits = sum(1 for k in crash_keywords if k in report_str)
    if oom_hits >= 3 and crash_hits >= 2:
        scores["root_cause_identified"] = 1.0
    elif oom_hits >= 2 and crash_hits >= 1:
        scores["root_cause_identified"] = 0.6
    elif oom_hits >= 1 or crash_hits >= 2:
        scores["root_cause_identified"] = 0.3

    # Trend data: restarts_24h=2 and consecutive_healthy=1
    # Require specific JSON field values or unambiguous phrases; avoid loose substring matches
    has_restarts_2 = (
        report.get("restarts_24h") == 2
        or report.get("total_restarts_24h") == 2
        or re.search(r'\b2\s+restart', report_str)
        or re.search(r'restart.{0,10}\b2\b', report_str)
    )
    has_consecutive_1 = (
        report.get("consecutive_healthy_checks") == 1
        or report.get("consecutive_healthy") == 1
        or "consecutive_healthy" in report_str          # exact field name present
        or re.search(r'consecutive.{0,20}\b1\b', report_str)
    )
    if has_restarts_2 and has_consecutive_1:
        scores["trend_data_accurate"] = 1.0
    elif has_restarts_2 or has_consecutive_1:
        scores["trend_data_accurate"] = 0.5

    # HEARTBEAT.md references specific log data
    hb_path = os.path.join(workspace_path, "HEARTBEAT.md")
    if os.path.isfile(hb_path):
        try:
            hb = open(hb_path, "r", encoding="utf-8").read().lower()
            specific_refs = [
                "3578" in hb,
                "1.4.2" in hb,
                "847" in hb or "1024" in hb,
                "03:02" in hb or "03:00" in hb or "last restart" in hb,
                "consecutive" in hb or "2 restart" in hb or "restarts" in hb,
                "event loop" in hb or "memory" in hb or "oom" in hb,
            ]
            ref_count = sum(1 for r in specific_refs if r)
            if ref_count >= 3:
                scores["heartbeat_grounded"] = 1.0
            elif ref_count >= 2:
                scores["heartbeat_grounded"] = 0.6
            elif ref_count >= 1:
                scores["heartbeat_grounded"] = 0.3
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Crash Pattern Root Cause Analysis (Weight: 30%)
- 1.0: Report correctly identifies that both crashes are driven by memory pressure: first crash shows OOM kill (exit code 137, memory at 847MB/1024MB limit); second crash shows event loop lag warnings (2341ms, 4102ms) preceding health endpoint timeout — both are memory saturation events. Root cause stated as memory exhaustion.
- 0.75: Both crashes mentioned with the correct root cause, but the connection between OOM in crash 1 and event loop lag in crash 2 (same underlying cause) is not explicitly made.
- 0.5: At least one crash correctly attributed to memory; the other is described vaguely or incorrectly.
- 0.25: Crashes mentioned but root cause analysis is generic ("gateway failed") without citing memory evidence from logs.
- 0.0: Root cause not analyzed, or report is entirely fabricated without referencing actual log entries.

### Log Cross-Reference Quality (Weight: 25%)
- 1.0: Report draws evidence from at least three distinct source files — cites specific timestamps and values from `gateway.log` (exit code 137, event loop lag ms), `health-check.log` (2-attempt restart on second crash), and `gateway-status.json` (consecutive_healthy: 1, total_restarts_24h: 2).
- 0.75: Evidence from 2–3 files with specific timestamps or numeric values cited; minor gaps.
- 0.5: Evidence from 1–2 files; some specific values cited but several key data points from the logs are missing.
- 0.25: Report references the logs conceptually but cites no specific timestamps, values, or error messages from the actual files.
- 0.0: No evidence of reading the actual log files; analysis is generic or fabricated.

### Skill Definition Quality (Weight: 20%)
- 1.0: SKILL.md is at `workspace/skills/gateway-health/SKILL.md`, has proper YAML frontmatter (name, description), and contains proactive monitoring guidance beyond just "run a health check" — covers early warning signals (event loop lag, memory usage thresholds), log correlation procedures, and how to distinguish recurring from one-off failures.
- 0.75: SKILL.md at correct path with frontmatter; covers health check and restart but lacks proactive/early-warning content.
- 0.5: SKILL.md exists but at wrong path (workspace root), or at correct path but with only reactive monitoring content.
- 0.25: SKILL.md exists at wrong path with minimal content.
- 0.0: SKILL.md not created.

### Recommendations Specificity (Weight: 15%)
- 1.0: Recommendations are concrete and tied to actual log evidence — e.g., "increase memory above 1024MB" (from exit code 137 and 847MB reading), "alert at 75% memory threshold" (before the 847MB limit is hit), "monitor event loop lag as early warning" (from 2341ms/4102ms warnings preceding crash 2).
- 0.75: At least two specific recommendations tied to evidence; one is generic.
- 0.5: Recommendations present but generic (e.g., "fix memory issues") without specific thresholds or evidence citations.
- 0.25: Minimal or unhelpful recommendations.
- 0.0: No recommendations, or deliverable missing.

### Output Completeness and Distractor Handling (Weight: 10%)
- 1.0: health_report.json is valid JSON with all required sections; HEARTBEAT.md contains specific log-grounded data; backup.yaml correctly identified as unrelated (or simply not mentioned in the analysis).
- 0.75: Both output files present with mostly correct content; minor gap in one section.
- 0.5: One output file missing or mostly empty; or agent incorrectly treats backup.yaml as a crash-related config.
- 0.25: Only one output file produced with minimal content.
- 0.0: Neither health_report.json nor HEARTBEAT.md produced.
