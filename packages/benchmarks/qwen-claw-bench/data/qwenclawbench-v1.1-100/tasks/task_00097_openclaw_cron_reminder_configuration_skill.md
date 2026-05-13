---
id: task_00097_openclaw_cron_reminder_configuration_skill
name: OpenClaw Cron Reminder Configuration Skill
category: Communication and Scheduling
subcategory: Reminders and Scheduled Tasks
grading_type: hybrid
grading_weights:
  automated: 0.6
  llm_judge: 0.4
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: sample-broken-config.json
  dest: sample-broken-config.json
- source: sample-working-config.json
  dest: sample-working-config.json
- source: reminder-tasks.json
  dest: reminder-tasks.json
- source: server-info.md
  dest: server-info.md
- source: commute-config.json
  dest: commute-config.json
- source: cron-jobs.json
  dest: cron-jobs.json
- source: health-data.json
  dest: health-data.json
- source: low-memory-config.json
  dest: low-memory-config.json
- source: simple-reminder.sh
  dest: simple-reminder.sh
- source: server-monitor.sh
  dest: server-monitor.sh
- source: smart-server-monitor.sh
  dest: smart-server-monitor.sh
---

## Prompt

I've been struggling with getting my OpenClaw cron reminder tasks to actually deliver messages. I have a bunch of reminder configs in workspace, they're all supposed to send messages via Telegram, but none of them are working.

Can you:

1. **Create a reusable skill**  that documents the correct configuration format for OpenClaw cron reminder tasks based on what you find. It should explain the required fields, common pitfalls, and how to fix broken configs.

2. **Fix all the broken configs** in `reminder-tasks.json` and write the corrected version to `reminder-tasks-fixed.json`. Make sure the commute reminders include the actual commute details from the workspace.

3. **Write `fix-report.md`** summarizing what was broken, what you changed, and any schedule timing issues you noticed. Check `server-info.md` for the server context.

## Expected Behavior

The agent should:

1. **Read all relevant workspace files** before making any changes — critical discoveries required:
   - `sample-broken-config.json` vs `sample-working-config.json` comparison reveals 4 missing fields: `enabled: true` at root level, `deliver: true` inside payload, a `Use: message action=send channel=telegram to=5992622663` instruction in the message text, and a `delivery` object with `mode/channel/to`.
   - `commute-config.json` has specific commute data: home station **Longhua Station (Line 7)**, office station **Zhangjiang High-Tech (Line 2)**, morning subway at **07:57** with reminderTime **07:50** (leaving 7 min to walk), evening subway at **18:47** with reminderTime **18:40**. The commute tasks in `reminder-tasks.json` fire at `"57 7 * * 1-5"` (07:57) and `"47 18 * * 1-5"` (18:47) — but these cron times match the **subway departure times**, not the reminderTimes from commute-config.json (07:50 and 18:40). This is a **7-minute timing discrepancy**: the reminder fires right as the train leaves rather than giving the user time to walk to the station.
   - `cron-jobs.json` contains 14 working examples with detailed message templates including emoji, station details, and specific subway times — these serve as style reference for the fixed messages.

2. **Create a SKILL.md file** in the workspace that:
   - Has YAML frontmatter with `name` and `description` fields
   - Documents required fields (`enabled`, `deliver`, `delivery` object, message format with send instruction)
   - Lists common pitfalls and how to fix them

3. **Create `reminder-tasks-fixed.json`** with all 6 tasks corrected. Critically, the two commute tasks must use data from `commute-config.json`:
   - `commute-subway-0757`: message should reference Longhua Station and/or Line 7
   - `commute-subway-1847`: message should reference Zhangjiang High-Tech and/or Line 2
   - All tasks need `enabled: true`, `deliver: true`, Telegram send instruction, and `delivery` object

4. **Create `fix-report.md`** that explains the missing fields, references server specs from `server-info.md`, and **flags the schedule timing discrepancy** — the commute cron times (07:57, 18:47) match subway departure times rather than the earlier reminderTimes in commute-config.json (07:50, 18:40), so the user will miss the train.

**Critical trap**: An agent that only reads `sample-broken-config.json` and `sample-working-config.json` will produce correctly structured JSON but with generic placeholder messages like "Send subway departure reminder" — completely missing the actual station names, line numbers, and timing discrepancy that require reading `commute-config.json`. The fix-report will also lack the timing flag.

## Grading Criteria

- [ ] SKILL.md exists with proper YAML frontmatter and documents correct cron reminder configuration format
- [ ] reminder-tasks-fixed.json exists, is valid JSON, and contains all 6 tasks
- [ ] Each task has required fields: `enabled: true`, `deliver: true`, and telegram message reference
- [ ] Each task has correct delivery object with channel and target
- [ ] Commute tasks in fixed JSON reference actual station data from commute-config.json (Longhua Station or Zhangjiang High-Tech)
- [ ] fix-report.md flags the schedule timing discrepancy (cron fires at departure time rather than reminderTime from commute-config.json)
- [ ] fix-report.md exists with meaningful content about the fixes
- [ ] Original task schedules and IDs are preserved

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import os
    import re

    scores = {
        "skill_md_exists_and_structured": 0.0,
        "fixed_json_valid_and_complete": 0.0,
        "all_tasks_have_required_fields": 0.0,
        "delivery_objects_correct": 0.0,
        "commute_tasks_use_station_data": 0.0,
        "report_flags_timing_discrepancy": 0.0,
        "fix_report_exists": 0.0,
        "original_ids_preserved": 0.0,
    }

    if not transcript:
        return scores

    # 1. Check SKILL.md exists and has frontmatter
    # Search recursively and case-insensitively so agents that write skill.md or
    # place it in a subdirectory still receive credit.
    import glob as _glob
    _skill_candidates = _glob.glob(
        os.path.join(workspace_path, "**", "[Ss][Kk][Ii][Ll][Ll].md"),
        recursive=True,
    )
    skill_path = _skill_candidates[0] if _skill_candidates else os.path.join(workspace_path, "SKILL.md")
    if os.path.isfile(skill_path):
        try:
            content = open(skill_path, "r", encoding="utf-8").read()
            has_frontmatter = content.strip().startswith("---")
            has_name = bool(re.search(r"name\s*:", content[:500]))
            has_description = bool(re.search(r"description\s*:", content[:500]))
            has_cron_content = any(
                kw in content.lower()
                for kw in ["enabled", "deliver", "cron", "reminder", "delivery"]
            )
            if has_frontmatter and has_name and has_description and has_cron_content:
                scores["skill_md_exists_and_structured"] = 1.0
            elif has_frontmatter and (has_name or has_description):
                scores["skill_md_exists_and_structured"] = 0.5
            elif len(content.strip()) > 50:
                scores["skill_md_exists_and_structured"] = 0.25
        except Exception:
            pass

    # 2. Check reminder-tasks-fixed.json exists and is valid JSON with 6 tasks
    fixed_path = os.path.join(workspace_path, "reminder-tasks-fixed.json")
    tasks = []
    if os.path.isfile(fixed_path):
        try:
            content = open(fixed_path, "r", encoding="utf-8").read()
            tasks = json.loads(content)
            if isinstance(tasks, list) and len(tasks) == 6:
                scores["fixed_json_valid_and_complete"] = 1.0
            elif isinstance(tasks, list) and len(tasks) >= 4:
                scores["fixed_json_valid_and_complete"] = 0.5
            elif isinstance(tasks, list) and len(tasks) > 0:
                scores["fixed_json_valid_and_complete"] = 0.25
        except (json.JSONDecodeError, Exception):
            scores["fixed_json_valid_and_complete"] = 0.1

    # 3. Check all tasks have required fields (enabled, deliver, telegram message)
    # deliver is satisfied by either payload.deliver==True OR a top-level delivery
    # object with a channel set (the format used by the working sample config).
    if tasks:
        enabled_count = 0
        deliver_count = 0
        message_count = 0
        for task in tasks:
            if task.get("enabled") is True:
                enabled_count += 1
            payload = task.get("payload", {})
            delivery = task.get("delivery", {})
            if payload.get("deliver") is True or delivery.get("channel") is not None:
                deliver_count += 1
            msg = payload.get("message", "")
            if "telegram" in msg.lower() and "5992622663" in msg:
                message_count += 1
        total = len(tasks)
        if total > 0:
            field_score = (enabled_count + deliver_count + message_count) / (total * 3)
            scores["all_tasks_have_required_fields"] = round(field_score, 2)

    # 4. Check delivery objects
    if tasks:
        delivery_ok = 0
        for task in tasks:
            delivery = task.get("delivery", {})
            if (
                delivery.get("channel") == "telegram"
                and str(delivery.get("to", "")) == "5992622663"
                and delivery.get("mode") == "announce"
            ):
                delivery_ok += 1
        if len(tasks) > 0:
            scores["delivery_objects_correct"] = round(delivery_ok / len(tasks), 2)

    # 5. Check commute tasks reference actual station data from commute-config.json
    # commute-config.json: home=Longhua Station (Line 7), office=Zhangjiang High-Tech (Line 2)
    # Use prefix matching so agents that legitimately update the time suffix in IDs
    # when fixing cron schedules still receive credit.
    if tasks:
        commute_tasks = [t for t in tasks if "commute" in t.get("id", "").lower()]
        station_terms = ["longhua", "zhangjiang", "line 7", "line 2"]
        commute_msgs = [t.get("payload", {}).get("message", "").lower() for t in commute_tasks]
        station_hits = sum(any(term in msg for term in station_terms) for msg in commute_msgs)
        if len(commute_tasks) >= 2 and station_hits >= 2:
            scores["commute_tasks_use_station_data"] = 1.0
        elif station_hits >= 1:
            scores["commute_tasks_use_station_data"] = 0.5

    # 6. Check fix-report.md flags the timing discrepancy
    # commute-config.json: reminderTime 07:50 (morning), 18:40 (evening)
    # reminder-tasks.json cron: 57 7 = 07:57 (departure time, not reminderTime)
    report_path = os.path.join(workspace_path, "fix-report.md")
    if os.path.isfile(report_path):
        try:
            report_text = open(report_path, "r", encoding="utf-8").read().lower()
            has_reminder_time = bool(re.search(r"(07:50|18:40|7.50|18.40|reminder.?time)", report_text))
            has_departure_time = bool(re.search(r"(07:57|18:47)", report_text))
            has_discrepancy_lang = bool(re.search(
                r"(too late|miss|late|walk|discrepan|mismatch|timing|early|ahead|departure|before|7.min|10.min)",
                report_text
            ))
            if has_reminder_time and has_departure_time and has_discrepancy_lang:
                scores["report_flags_timing_discrepancy"] = 1.0
            elif (has_departure_time or has_reminder_time) and has_discrepancy_lang:
                scores["report_flags_timing_discrepancy"] = 0.5
        except Exception:
            pass

    # 7. Check fix-report.md exists with meaningful content
    if os.path.isfile(report_path):
        try:
            content = open(report_path, "r", encoding="utf-8").read()
            if len(content.strip()) > 100:
                scores["fix_report_exists"] = 1.0
            elif len(content.strip()) > 20:
                scores["fix_report_exists"] = 0.5
        except Exception:
            pass

    # 8. Check original IDs are preserved
    # Exact match scores 1 point per ID; prefix-only match (agent changed trailing
    # time digits when fixing cron) scores 0.5.  Non-commute IDs must be exact.
    expected_id_prefixes = {
        "health-sitting-0920": "health-sitting-0920",
        "health-sitting-1050": "health-sitting-1050",
        "health-weight-2300": "health-weight-2300",
        "commute-subway-0757": "commute-subway-",
        "commute-subway-1847": "commute-subway-",
        "weather-alert-1600": "weather-alert-1600",
    }
    if tasks:
        found_ids = {task.get("id", "") for task in tasks}
        matched = 0.0
        for exact_id, prefix in expected_id_prefixes.items():
            if exact_id in found_ids:
                matched += 1.0
            elif exact_id != prefix and any(fid.startswith(prefix) for fid in found_ids):
                matched += 0.5
        scores["original_ids_preserved"] = round(min(matched / len(expected_id_prefixes), 1.0), 2)

    return scores
```

## LLM Judge Rubric

### Commute Data Integration (Weight: 25%)
Evaluates whether the agent read `commute-config.json` and used its data in the fixed configs and report. An agent that only reads `sample-broken-config.json` vs `sample-working-config.json` will produce correct structure but generic placeholder messages.

- **1.0**: Both commute tasks (`commute-subway-0757` and `commute-subway-1847`) in the fixed JSON have messages referencing actual station data (Longhua Station, Zhangjiang High-Tech, Line 7, or Line 2); AND fix-report.md flags the timing discrepancy (cron fires at 07:57/18:47 which are subway departure times, not the earlier reminderTimes 07:50/18:40 from commute-config.json — meaning the reminder fires as the train is already leaving).
- **0.75**: Station data is used in both commute messages, but the timing discrepancy is not flagged (or vice versa — discrepancy noted but only one commute message has station data).
- **0.5**: One commute message has station data, or the timing issue is mentioned vaguely without specifics.
- **0.25**: Commute message texts are generic ("Send subway departure reminder") with no station names, and no timing issue mentioned.
- **0.0**: Commute tasks are unchanged from the original except for structural fields, with no evidence of reading commute-config.json.

### Configuration Fix Correctness (Weight: 25%)
- **1.0**: All 6 tasks in reminder-tasks-fixed.json are correctly fixed with `enabled: true`, `deliver: true`, proper Telegram message format, and complete delivery objects; original schedules and IDs preserved.
- **0.75**: Most tasks (5 of 6) fully correct, or all 6 have a minor issue in one field.
- **0.5**: At least half the tasks are fixed correctly, but some are missing required fields or have formatting issues.
- **0.25**: Some attempt at fixing tasks but significant fields are missing or incorrect across most tasks.
- **0.0**: No fixed configuration file produced, or invalid JSON, or tasks are not meaningfully corrected.

### Skill Quality and Reusability (Weight: 20%)
- **1.0**: SKILL.md is well-structured with YAML frontmatter (name, description), clearly documents the correct cron reminder format, lists all required fields, explains common pitfalls, and is written as a reusable knowledge module.
- **0.75**: SKILL.md exists with frontmatter and covers most required fields but may lack pitfall details or reusability framing.
- **0.5**: SKILL.md exists but is incomplete — missing frontmatter or only partially documents the configuration format.
- **0.25**: SKILL.md exists but is minimal or poorly structured, not useful as a reusable skill.
- **0.0**: SKILL.md is missing, empty, or contains no relevant configuration documentation.

### Fix Report Completeness (Weight: 15%)
- **1.0**: fix-report.md explains what was broken (missing `enabled`, `deliver`, delivery object, message format), what was fixed, flags the commute schedule timing discrepancy, and references server specs from server-info.md.
- **0.75**: Report covers the missing fields and fixes but omits the timing discrepancy or server spec reference.
- **0.5**: Report exists and mentions some fixes but is incomplete or vague.
- **0.25**: Report exists but is very brief or doesn't meaningfully describe the fixes.
- **0.0**: No fix report produced or report is empty/irrelevant.

### Evidence and Workspace Grounding (Weight: 15%)
- **1.0**: Agent clearly read multiple workspace files (sample configs, commute-config.json, server-info.md), outputs contain specific data from each, and all files are mutually consistent.
- **0.75**: Agent read most input files with minor gaps in cross-referencing.
- **0.5**: Agent produced outputs but shows limited evidence of reading the provided files; some content appears generic.
- **0.25**: Outputs exist but appear disconnected from the specific workspace files provided.
- **0.0**: No evidence of reading input files; outputs are missing or entirely hallucinated.
