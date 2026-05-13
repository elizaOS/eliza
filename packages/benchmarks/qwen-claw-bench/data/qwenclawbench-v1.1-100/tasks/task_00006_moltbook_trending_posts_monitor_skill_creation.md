---
id: task_00006_moltbook_trending_posts_monitor_skill_creation
name: Moltbook Trending Posts Monitor Skill Creation
category: Workflow and Agent Orchestration
subcategory: Script and Terminal Automation
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: moltbook-monitor/config.yaml
  dest: moltbook-monitor/config.yaml
- source: moltbook-monitor/scripts/monitor.sh
  dest: moltbook-monitor/scripts/monitor.sh
- source: moltbook-monitor/scripts/push_notification.py
  dest: moltbook-monitor/scripts/push_notification.py
- source: moltbook-monitor/scripts/dedup.py
  dest: moltbook-monitor/scripts/dedup.py
- source: moltbook-monitor/templates/summary.md
  dest: moltbook-monitor/templates/summary.md
- source: moltbook-monitor/logs/monitor.log
  dest: moltbook-monitor/logs/monitor.log
- source: moltbook-monitor/cache/seen_posts.json
  dest: moltbook-monitor/cache/seen_posts.json
- source: moltbook-monitor/cache/last_run.json
  dest: moltbook-monitor/cache/last_run.json
---

## Prompt

The Moltbook cron should have fired 26 minutes ago but nothing has run since 15:30 UTC yesterday. It's currently 12:26 AM on February 10th (Asia/Shanghai) — the monitoring window should be open right now. Please check all the relevant files (config, script, logs, cache), diagnose exactly what's blocked and why, then write a run report to `moltbook-monitor/logs/run_report.json` with your full findings. I also need a proper skill definition at `workspace/skills/moltbook-monitor/SKILL.md` — it must accurately reflect how the active-hours check in the script actually works (not just what the config says), which environment variables are needed, and which notification channels would actually fire. Don't just repeat the config YAML; the skill doc needs to be correct enough that someone could debug or replicate this setup without reading the source.

## Expected Behavior

The agent should:

1. Read `moltbook-monitor/config.yaml` and extract key operational parameters:
   - Active hours: start 07:00, end 01:00, timezone Asia/Shanghai
   - Required env vars: `MOLTBOOK_API_KEY` (from `moltbook.auth.api_key_env`), `MOLTBOT_WEBHOOK_URL` (from `notification.channels[0].url_env`), `TG_CHAT_ID`, `TG_BOT_TOKEN` (from channels[1])
   - Notification channels: webhook `moltbot-primary` (enabled), telegram `tg-moltbook-feed` (enabled), discord `discord-trending` (**disabled**)
   - Schedule: every 30 minutes; thresholds: hot ≥ 500, viral ≥ 2000; dedup window: 12 hours, strategy: post_id

2. Read `moltbook-monitor/scripts/monitor.sh` and trace the active-hours check logic:
   - The script's skip condition is: `CURRENT_HOUR >= 1 && CURRENT_HOUR < 7`
   - At 12:26 AM CST (hour = 0), this condition is **false** — the monitor WOULD execute
   - This means the config's "end: 01:00" translates to: hours 1–6 are inactive, but hour 0 (00:00–00:59) is still active
   - Agent must correctly identify this: the run at 12:26 AM is NOT blocked by active-hours

3. Read `moltbook-monitor/cache/last_run.json`:
   - Last successful run: 2026-02-09T15:30:12Z
   - Current time: 2026-02-09T16:26Z (UTC equivalent of 12:26 AM CST Feb 10)
   - Time since last run: ~56 minutes; schedule period: 30 minutes → run is ~26 minutes overdue

4. Read `moltbook-monitor/logs/monitor.log` and note:
   - 6 runs recorded on 2026-02-09, all successful except one 429 error at 12:00 UTC (recovered with retry)
   - No run recorded after 15:30 UTC → confirms the cron gap

5. Read `moltbook-monitor/cache/seen_posts.json`:
   - 15 post entries in the cache
   - Dedup window is 12 hours from current run time; entries with ts < (now - 43200) would be expired

6. Diagnose the root cause: `MOLTBOOK_API_KEY` environment variable is not set — the script checks for this immediately after the active-hours check and exits with code 1 if missing.

7. Write `workspace/skills/moltbook-monitor/SKILL.md` with:
   - Valid YAML frontmatter: `name: moltbook-monitor` and `description`
   - Section documenting the active-hours behavior **precisely**: hours 1–6 CST are inactive; hour 0 (midnight to 01:00) is active — this is an important distinction from reading the config `end: "01:00"` naively
   - Section listing all 4 required environment variables by their exact names from the config
   - Section on notification channels: 2 enabled (webhook + telegram), 1 disabled (discord) — must not list discord as active
   - Section on dedup behavior: 12-hour window, post_id strategy, cache file path
   - Section on post classification thresholds: hot ≥ 500, viral ≥ 2000

8. Write `moltbook-monitor/logs/run_report.json` — valid JSON containing at minimum:
   - `timestamp`: ISO-8601 string matching or near 2026-02-10T00:26+08:00
   - `status`: "failed"
   - `active_hours_check`: object confirming the run WOULD proceed at hour 0 (e.g., `{ "current_hour_cst": 0, "would_execute": true }`)
   - `missing_env_vars`: array including at least `"MOLTBOOK_API_KEY"`
   - `channels_would_fire`: array containing `"moltbot-primary"` and `"tg-moltbook-feed"` but NOT `"discord-trending"`
   - `time_since_last_run_minutes`: a number approximately 56 (acceptable range: 50–65)
   - `errors`: non-empty array describing the failure

Key traps:
- Agent may say the monitor is "outside active hours" at 12:26 AM — wrong, hour 0 is active; only hours 1–6 are inactive per the script's skip condition.
- Agent may list discord as a channel that would fire — wrong, it is explicitly disabled in config.
- Agent may use incorrect env var names (e.g. `MOLTBOOK_WEBHOOK_URL` instead of `MOLTBOT_WEBHOOK_URL`).
- Agent may not reference monitor.sh to verify the active-hours logic and just copy config values.
- Agent may omit `time_since_last_run_minutes` or compute it incorrectly.

## Grading Criteria

- [ ] `workspace/skills/moltbook-monitor/SKILL.md` exists with valid YAML frontmatter containing `name` and `description`
- [ ] SKILL.md correctly documents that hour 0 (midnight–01:00 CST) is active (only hours 1–6 are skipped), not just echoing the config's "end: 01:00"
- [ ] SKILL.md lists all 4 required env var names correctly (MOLTBOOK_API_KEY, MOLTBOT_WEBHOOK_URL, TG_CHAT_ID, TG_BOT_TOKEN)
- [ ] SKILL.md correctly states that discord channel is disabled and does not list it as an active notification target
- [ ] `moltbook-monitor/logs/run_report.json` is valid JSON with `status`, `timestamp`, and `errors` fields
- [ ] run_report.json contains `active_hours_check` confirming the run would proceed at hour 0
- [ ] run_report.json lists `MOLTBOOK_API_KEY` in missing env vars
- [ ] run_report.json channels list includes webhook and telegram but NOT discord

## Automated Checks

```python
import json
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "skill_md_structured": 0.0,
        "skill_md_active_hours_correct": 0.0,
        "skill_md_env_vars_correct": 0.0,
        "skill_md_channels_discord_excluded": 0.0,
        "run_report_valid_json_with_fields": 0.0,
        "run_report_active_hours_correct": 0.0,
        "run_report_channels_correct": 0.0,
    }

    ws = Path(workspace_path)

    # 1. SKILL.md structure
    skill_path = ws / "skills" / "moltbook-monitor" / "SKILL.md"
    skill_content = ""
    if skill_path.exists():
        try:
            skill_content = skill_path.read_text(encoding="utf-8", errors="replace")
            fm_match = re.search(r"^---\s*\n(.*?)\n---", skill_content, re.DOTALL)
            has_name = False
            has_desc = False
            if fm_match:
                fm = fm_match.group(1)
                has_name = bool(re.search(r"^name\s*:", fm, re.MULTILINE))
                has_desc = bool(re.search(r"^description\s*:", fm, re.MULTILINE))
            headings = re.findall(r"^#{1,3}\s+.+", skill_content, re.MULTILINE)
            if skill_content.strip().startswith("---") and has_name and has_desc and len(headings) >= 3:
                scores["skill_md_structured"] = 1.0
            elif skill_content.strip().startswith("---") and (has_name or has_desc):
                scores["skill_md_structured"] = 0.5
            elif skill_path.stat().st_size > 200:
                scores["skill_md_structured"] = 0.25
        except Exception:
            pass

    # 2. SKILL.md active hours correctness
    if skill_content:
        sc_lower = skill_content.lower()
        # Should mention that hours 1-6 are inactive (not just "07:00-01:00")
        mentions_hour_range = bool(re.search(r"hour[s]?\s*[1-6]|1\s*[-–]\s*6|hours?\s+1\s+through\s+6|01:00.*inactive|inactive.*01:00", sc_lower))
        # Should indicate hour 0 is active OR midnight is active
        mentions_hour_0_active = bool(re.search(r"hour\s*0|midnight.*active|00:00.*active|0{1,2}:00.*active|active.*midnight|active.*00:00", sc_lower))
        # Should NOT say the monitor skips at midnight/00:00
        says_skip_midnight = bool(re.search(r"skip.*midnight|midnight.*skip|skip.*00:00|00:00.*skip", sc_lower))
        if (mentions_hour_range or mentions_hour_0_active) and not says_skip_midnight:
            scores["skill_md_active_hours_correct"] = 1.0
        elif mentions_hour_range and not says_skip_midnight:
            scores["skill_md_active_hours_correct"] = 0.5
        elif not says_skip_midnight and ("07:00" in skill_content or "active" in sc_lower):
            scores["skill_md_active_hours_correct"] = 0.25

    # 3. SKILL.md env vars correctness
    if skill_content:
        ev_names = ["MOLTBOOK_API_KEY", "MOLTBOT_WEBHOOK_URL", "TG_CHAT_ID", "TG_BOT_TOKEN"]
        found_ev = sum(1 for ev in ev_names if ev in skill_content)
        if found_ev >= 4:
            scores["skill_md_env_vars_correct"] = 1.0
        elif found_ev >= 3:
            scores["skill_md_env_vars_correct"] = 0.7
        elif found_ev >= 2:
            scores["skill_md_env_vars_correct"] = 0.4
        elif found_ev >= 1:
            scores["skill_md_env_vars_correct"] = 0.2

    # 4. SKILL.md channels: discord excluded
    if skill_content:
        sc_lower = skill_content.lower()
        mentions_webhook = "moltbot-primary" in skill_content or "webhook" in sc_lower
        mentions_telegram = "tg-moltbook-feed" in skill_content or "telegram" in sc_lower
        # Discord should be mentioned as disabled, not as an active channel
        discord_mentioned = "discord" in sc_lower
        discord_disabled_noted = bool(re.search(r"discord.{0,40}(disabled|inactive|not enabled|off)", sc_lower))
        discord_listed_active = bool(re.search(r"(active|enabled|fire|push|send).{0,30}discord(?!.{0,30}disabled)", sc_lower))
        if mentions_webhook and mentions_telegram and not discord_listed_active:
            scores["skill_md_channels_discord_excluded"] = 1.0
        elif mentions_webhook and mentions_telegram:
            scores["skill_md_channels_discord_excluded"] = 0.5
        elif mentions_webhook or mentions_telegram:
            scores["skill_md_channels_discord_excluded"] = 0.25

    # 5. run_report.json valid JSON with required fields
    report_path = ws / "moltbook-monitor" / "logs" / "run_report.json"
    report_data = None
    if report_path.exists():
        try:
            report_data = json.loads(report_path.read_text(encoding="utf-8", errors="replace"))
            required = ["status", "timestamp", "errors"]
            found = sum(1 for f in required if f in report_data)
            has_failed = report_data.get("status", "").lower() in ("failed", "error", "failure")
            if found == 3 and has_failed:
                scores["run_report_valid_json_with_fields"] = 1.0
            elif found >= 2:
                scores["run_report_valid_json_with_fields"] = 0.5
            elif found >= 1:
                scores["run_report_valid_json_with_fields"] = 0.25
            # Bonus: check for structured fields — missing_env_vars and time_since_last_run
            if report_data and isinstance(report_data, dict):
                rd_str = json.dumps(report_data).lower()
                has_missing_env = bool(re.search(r"(missing_env|missing.*env|moltbook_api_key)", rd_str))
                has_time_field = bool(re.search(r"(time_since_last_run|time_since|minutes_overdue|last_run)", rd_str))
                if has_missing_env:
                    scores["run_report_valid_json_with_fields"] = min(scores["run_report_valid_json_with_fields"] + 0.1, 1.0)
                if has_time_field:
                    scores["run_report_valid_json_with_fields"] = min(scores["run_report_valid_json_with_fields"] + 0.1, 1.0)
        except Exception:
            pass

    # 6. run_report active_hours check
    if report_data and isinstance(report_data, dict):
        raw = json.dumps(report_data).lower()
        # Should indicate would_execute = true OR hour 0 is active
        would_execute = (
            "would_execute.*true" in re.sub(r'\s+', '', raw)
            or bool(re.search(r'"would_execute"\s*:\s*true', raw))
            or bool(re.search(r'hour.{0,20}0|current_hour.{0,10}0', raw))
            or bool(re.search(r'active.{0,30}hour|within.{0,20}window', raw))
        )
        # Should NOT say outside active hours
        says_outside = bool(re.search(r"outside.{0,20}(active|hour|window)|inactive.{0,20}hour", raw))
        if would_execute and not says_outside:
            scores["run_report_active_hours_correct"] = 1.0
        elif not says_outside:
            scores["run_report_active_hours_correct"] = 0.5

    # 7. run_report channels correct
    if report_data and isinstance(report_data, dict):
        raw_str = json.dumps(report_data)
        raw_lower = raw_str.lower()
        has_webhook = "moltbot-primary" in raw_str or "webhook" in raw_lower
        has_telegram = "tg-moltbook-feed" in raw_str or "telegram" in raw_lower
        # discord should NOT appear as would-fire (may appear as disabled/excluded)
        discord_as_active = bool(re.search(r'"discord[^"]*"(?=(?:(?!"disabled|excluded|not").)*"would_fire|"channels_would_fire)', raw_str))
        channels_key = None
        for k in ("channels_would_fire", "channels_that_would_fire", "would_fire_channels", "active_channels"):
            if k in report_data:
                channels_key = k
                break
        if channels_key:
            ch_list = report_data[channels_key]
            if isinstance(ch_list, list):
                ch_lower = [str(c).lower() for c in ch_list]
                has_wh = any("webhook" in c or "moltbot" in c or "primary" in c for c in ch_lower)
                has_tg = any("telegram" in c or "tg-" in c for c in ch_lower)
                no_discord = not any("discord" in c for c in ch_lower)
                if has_wh and has_tg and no_discord:
                    scores["run_report_channels_correct"] = 1.0
                elif (has_wh or has_tg) and no_discord:
                    scores["run_report_channels_correct"] = 0.5
                elif has_wh and has_tg:
                    scores["run_report_channels_correct"] = 0.25
        elif has_webhook and has_telegram:
            scores["run_report_channels_correct"] = 0.5

    return scores
```

## LLM Judge Rubric

### Active-Hours Analysis Accuracy (Weight: 30%)
Evaluates whether the agent correctly traced the active-hours logic through both config.yaml and monitor.sh, and reflected this accurately in both the run_report.json and SKILL.md.

- 1.0: Agent correctly identifies that at 12:26 AM CST (hour 0), the monitor WOULD execute — the script's skip condition (`CURRENT_HOUR >= 1 && CURRENT_HOUR < 7`) excludes hour 0. Both SKILL.md and run_report.json reflect this correctly, distinguishing the script logic from a naive reading of the config's "end: 01:00".
- 0.75: Agent correctly identifies the monitor would run at 00:26 CST, but does not explicitly explain the hour-0 nuance or the script-vs-config discrepancy.
- 0.5: Agent acknowledges the active-hours configuration but either reaches the wrong conclusion (says midnight is outside active hours) or does not trace the script logic.
- 0.25: Agent references active hours but makes factually incorrect claims (e.g., says the monitor is paused because it is "after 1 AM").
- 0.0: Agent does not check active hours at all or claims the monitor should not run.

### Diagnostic Completeness (Weight: 25%)
Evaluates whether the agent correctly identified the root cause, all missing env vars, and the overdue-run situation from the available files.

- 1.0: Agent identifies MOLTBOOK_API_KEY as the root cause; lists all 4 required env vars by exact name from config; notes the run is ~26 minutes overdue (last run 15:30Z, scheduled every 30 min, current time 16:26Z); correctly identifies discord as disabled and excludes it from active channels; references the 429 retry incident in monitor.log as a precursor pattern.
- 0.75: Identifies MOLTBOOK_API_KEY as root cause and discord as disabled; correctly names most env vars; notes overdue run but timing calculation off.
- 0.5: Identifies missing API key and some env vars; may confuse discord as active; does not address overdue schedule.
- 0.25: Only identifies one or two issues without full diagnostics.
- 0.0: Does not identify root cause or misidentifies it.

### SKILL.md Documentation Quality (Weight: 25%)
Evaluates whether the skill document is accurate, reusable, and actionable — not just a paraphrase of the config.

- 1.0: SKILL.md has valid frontmatter; accurately documents active-hours as "inactive from 01:00–07:00 CST (hours 1–6), including midnight–01:00 as active"; lists all 4 env vars by exact name; correctly notes only 2 channels active (webhook + telegram); describes dedup behavior (12h, post_id); documents post classification thresholds. Structured well enough to debug or replicate without reading source files.
- 0.75: Mostly accurate; one minor error (e.g., one env var name slightly wrong, or missing dedup details).
- 0.5: Covers main points but has a substantive error (e.g., says discord is active, or misrepresents active-hours).
- 0.25: Skill exists with frontmatter but content is thin, generic, or inaccurate on key details.
- 0.0: SKILL.md missing, empty, or has no meaningful skill definition.

### run_report.json Accuracy and Richness (Weight: 20%)
Evaluates the quality of the run_report.json diagnostic output.

- 1.0: Valid JSON; `status: "failed"`; `active_hours_check` confirms would_execute=true at hour 0; `missing_env_vars` includes MOLTBOOK_API_KEY (with exact name); `channels_would_fire` lists webhook + telegram only (no discord); `time_since_last_run_minutes` in range 50–65; `errors` list non-empty with specific failure description. All values derivable from actual workspace files.
- 0.75: All required fields present with mostly correct values; one minor inaccuracy (e.g., discord mentioned but as disabled, time off by a few minutes).
- 0.5: Valid JSON with status + errors, but missing active_hours_check or channels analysis, or contains a major factual error.
- 0.25: File exists but sparse — only 2–3 generic fields with no diagnostic depth.
- 0.0: File missing, not valid JSON, or contains only placeholder content.
