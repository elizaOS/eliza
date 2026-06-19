---
id: task_00093_openclaw_cron_job_reminder_configuration_review
name: OpenClaw Cron Job Reminder Configuration Review
category: Communication and Scheduling
subcategory: Reminders and Scheduled Tasks
grading_type: hybrid
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
grading_weights:
  automated: 0.4
  llm_judge: 0.6
workspace_files:
- source: cron-jobs.json
  dest: cron-jobs.json
- source: commute-config.json
  dest: commute-config.json
- source: openclaw-config.json
  dest: openclaw-config.json
- source: low-memory-config.json
  dest: low-memory-config.json
- source: server-monitor.sh
  dest: server-monitor.sh
- source: health-data.json
  dest: health-data.json
---

## Prompt

I have 13 cron jobs set up in cron-jobs.json and a bunch of related config files. The commute reminders don't seem to be firing at the right time relative to when the subway actually departs, and I'm not sure whether my memory optimization settings are consistent across files. Can you do a thorough audit? Go through the files, and write a full audit report to reminder-audit.md covering: (1) whether any job has a timing error compared to what the config files actually say, (2) any cross-file inconsistencies in settings, (3) any security or reliability concerns, (4) whether all referenced workspace files actually exist, and (5) which jobs should probably be cleaned up. Also save a machine-readable `audit-findings.json` listing each issue found (with fields: `job_id`, `issue_type`, `evidence_file`, `finding`, `recommendation`).

## Expected Behavior

The agent should:

1. Read `cron-jobs.json` (13 jobs total) and understand what each job does and when it fires.

2. Cross-reference commute job timing with `commute-config.json`:
   - commute-config.json specifies `reminderMinutesBefore: 10` for both morning and evening subway.
   - Morning subway departs at **07:57**; a 10-minute-early reminder should fire at **07:47** → cron expr `47 7 * * 1-5`.
   - Evening subway departs at **18:47**; reminder should fire at **18:37** → cron expr `37 18 * * 1-5`.
   - But both commute jobs in cron-jobs.json use the departure time itself (`57 7` and `47 18`) rather than 10 minutes before — this is a **timing bug**. The reminders are firing at the exact moment the train leaves, not giving the user advance notice.

3. Cross-reference memory config between files:
   - `low-memory-config.json` sets `maxContextTokens: 4096`.
   - `openclaw-config.json` sets `memory.maxContextTokens: 8192`.
   - These two files conflict on the same parameter. The more restrictive 4096 value exists for a reason (1638MB RAM server) but the main config overrides it with 8192, negating the optimization.

4. Identify the security concern in `openclaw-config.json`:
   - `"host": "0.0.0.0"` binds the OpenClaw server to all network interfaces, potentially exposing it to public access.
   - This is noted as a security risk given the server is on Tencent Cloud.

5. Identify the expired one-time test task:
   - Job `94de43f5-...` ("Ultimate Test Task") has `"kind": "at"` with `"at": "2026-02-06T01:16:00Z"` — a one-time task that already ran (or was skipped) in the past. It has `enabled: false` but still occupies space. It should be cleaned up.

6. Identify the weekly report job's missing workspace files:
   - The "Weekly Report - Friday 17:00" job payload references `worklog-data.json` and `weekly-report-config.json`. Neither file exists in the current workspace. Without these files the job will fail silently each Friday.

7. Confirm what IS consistent and working correctly:
   - All sitting reminders (6 jobs): schedule matches health-data.json `sittingReminders.schedule` exactly ✓
   - Weight tracking job: 23:00 daily ✓
   - Memory monitor: every 4 hours matches low-memory-config.json `checkIntervalHours: 4` ✓, and alert threshold 300MB matches `alertBelowMB: 300` ✓

8. Write `reminder-audit.md` with:
   - A summary of all findings
   - The commute timing bug with specific corrected cron expressions (`47 7 * * 1-5` and `37 18 * * 1-5`)
   - The maxContextTokens conflict (4096 vs 8192) with a recommendation
   - The security concern about `0.0.0.0`
   - The expired test task cleanup recommendation
   - The missing worklog files needed by the weekly report job
   - Confirmation of the jobs that are configured correctly

9. Write `audit-findings.json` — a structured list of issues found, where each item includes at minimum:
   - `job_id` or `config_file`: which job or file the issue applies to
   - `issue_type`: one of `timing_error`, `config_conflict`, `security`, `missing_file`, `stale_job`, `correct`
   - `evidence_file`: which config file contains the evidence
   - `finding`: a brief description of the problem
   - `recommendation`: a specific corrective action (e.g., corrected cron expression or config value)

Key traps:
- Agent may not notice the commute timing mismatch because the departure time and the cron expression look plausible independently — the bug only emerges from cross-referencing with commute-config.json's `reminderMinutesBefore` field.
- Agent may miss the maxContextTokens conflict because the same parameter name appears under different keys in different files.
- Agent may overlook the `0.0.0.0` security issue by not reading openclaw-config.json carefully.
- Agent may list the test task as "needs fixing" rather than "should be deleted" because its purpose was a one-time verification, not an ongoing reminder.

## Grading Criteria

- [ ] reminder-audit.md exists and is non-empty
- [ ] Report identifies the commute timing bug: reminders fire at departure time instead of `reminderMinutesBefore: 10` earlier, and provides the corrected cron expressions (47 and 37 minutes)
- [ ] Report identifies the maxContextTokens inconsistency between low-memory-config.json (4096) and openclaw-config.json (8192)
- [ ] Report identifies the security concern: host binding to 0.0.0.0
- [ ] Report identifies the expired/stale test task (94de43f5) and recommends cleanup
- [ ] Report identifies that the weekly report job references missing files (worklog-data.json or weekly-report-config.json)
- [ ] Report confirms which jobs are correctly configured (sitting reminders, weight tracking, memory monitor)
- [ ] `audit-findings.json` exists as valid JSON with structured findings (each item contains issue_type and evidence_file or equivalent fields)

## Automated Checks

```python
import re
import json
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "report_exists": 0.0,
        "commute_timing_bug_identified": 0.0,
        "context_tokens_conflict_identified": 0.0,
        "security_host_binding_identified": 0.0,
        "stale_test_task_identified": 0.0,
        "missing_worklog_files_identified": 0.0,
        "correctly_configured_jobs_confirmed": 0.0,
        "structured_findings_json_exists": 0.0,
    }

    ws = Path(workspace_path)
    report_path = ws / "reminder-audit.md"
    if not report_path.exists():
        return scores

    try:
        content = report_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return scores

    if len(content.strip()) < 80:
        return scores

    scores["report_exists"] = 1.0
    cl = content.lower()

    # 1. Commute timing bug: mention of firing at departure vs 10 min before
    has_corrected_morning = bool(re.search(r"47\s*7|7:47|47 min|cron.*47.*7", cl))
    has_corrected_evening = bool(re.search(r"37\s*18|18:37|37 min|cron.*37.*18", cl))
    has_timing_concept = bool(re.search(r"(before|early|advance|prior|depart|minutes?\s+before|reminder.*minut|minut.*before)", cl))
    if (has_corrected_morning or has_corrected_evening) and has_timing_concept:
        scores["commute_timing_bug_identified"] = 1.0
    elif has_corrected_morning or has_corrected_evening:
        scores["commute_timing_bug_identified"] = 0.5
    elif has_timing_concept and "commute" in cl:
        scores["commute_timing_bug_identified"] = 0.25

    # 2. maxContextTokens conflict: both values mentioned with conflict context
    has_4096 = "4096" in content
    has_8192 = "8192" in content
    has_conflict_concept = bool(re.search(r"(conflict|inconsisten|mismatch|disagree|differ|contradict|override)", cl))
    has_context_tokens = bool(re.search(r"(context.*token|maxcontexttoken|token.*limit)", cl))
    if has_4096 and has_8192 and (has_conflict_concept or has_context_tokens):
        scores["context_tokens_conflict_identified"] = 1.0
    elif has_4096 and has_8192:
        scores["context_tokens_conflict_identified"] = 0.5
    elif (has_4096 or has_8192) and has_context_tokens:
        scores["context_tokens_conflict_identified"] = 0.25

    # 3. Security / host 0.0.0.0
    has_host = bool(re.search(r"0\.0\.0\.0|all.*interface|network.*expos|public.*access|bind.*all", cl))
    has_security_concept = bool(re.search(r"(security|expos|public|risk|vulnerab|open|bind)", cl))
    if has_host and has_security_concept:
        scores["security_host_binding_identified"] = 1.0
    elif has_host:
        scores["security_host_binding_identified"] = 0.5
    elif has_security_concept and "host" in cl:
        scores["security_host_binding_identified"] = 0.25

    # 4. Stale/expired test task
    has_test_task = bool(re.search(r"(94de|test.*task|ultimate.*test|one.?time|expired|stale|past.*schedul|schedul.*past|2026-02-06|already.*ran|ran.*already)", cl))
    has_cleanup = bool(re.search(r"(clean|remov|delet|obsolet|no longer|archiv)", cl))
    if has_test_task and has_cleanup:
        scores["stale_test_task_identified"] = 1.0
    elif has_test_task:
        scores["stale_test_task_identified"] = 0.5

    # 5. Missing worklog/weekly report files
    has_missing_files = bool(re.search(r"(worklog|weekly.?report.?config|missing.*file|file.*missing|not.*exist|doesn.t.*exist)", cl))
    has_weekly = bool(re.search(r"weekly.*report|report.*weekly", cl))
    if has_missing_files and has_weekly:
        scores["missing_worklog_files_identified"] = 1.0
    elif has_missing_files or (has_weekly and "file" in cl):
        scores["missing_worklog_files_identified"] = 0.5

    # 6. Correctly configured jobs confirmed
    has_sitting = bool(re.search(r"sitting.*reminder|sitting.*correct|sitting.*ok|sitting.*work", cl))
    has_memory_monitor = bool(re.search(r"memory.*monitor|monitor.*correct|monitor.*ok", cl))
    has_weight = bool(re.search(r"weight.*track|weight.*correct|weight.*ok", cl))
    correct_count = sum([has_sitting, has_memory_monitor, has_weight])
    if correct_count >= 3:
        scores["correctly_configured_jobs_confirmed"] = 1.0
    elif correct_count >= 2:
        scores["correctly_configured_jobs_confirmed"] = 0.6
    elif correct_count >= 1:
        scores["correctly_configured_jobs_confirmed"] = 0.3

    # 7. Structured audit-findings.json exists with required fields
    findings_path = ws / "audit-findings.json"
    if findings_path.exists():
        try:
            findings = json.loads(findings_path.read_text(encoding="utf-8", errors="replace"))
            # Accept list or dict with a findings key
            items = findings if isinstance(findings, list) else findings.get("findings", findings.get("issues", []))
            if isinstance(items, list) and len(items) >= 3:
                # Check that items have structured fields
                has_issue_type = any(
                    isinstance(i, dict) and any(k in i for k in ("issue_type", "type", "category"))
                    for i in items
                )
                has_evidence = any(
                    isinstance(i, dict) and any(k in i for k in ("evidence_file", "file", "source", "config_file"))
                    for i in items
                )
                if has_issue_type and has_evidence:
                    scores["structured_findings_json_exists"] = 1.0
                elif has_issue_type or has_evidence:
                    scores["structured_findings_json_exists"] = 0.6
                else:
                    scores["structured_findings_json_exists"] = 0.3
            elif isinstance(items, list) and len(items) >= 1:
                scores["structured_findings_json_exists"] = 0.3
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Commute Timing Analysis Accuracy (Weight: 30%)
Evaluates whether the agent correctly identified the timing mismatch between cron expressions and commute-config.json, and provided corrected values.

- 1.0: Agent reads both cron-jobs.json and commute-config.json, identifies that both commute jobs fire at the exact subway departure time (7:57 and 18:47) rather than `reminderMinutesBefore: 10` earlier (7:47 and 18:37), and provides the correct cron expressions (`47 7 * * 1-5` and `37 18 * * 1-5`).
- 0.75: Agent identifies the timing problem and gives corrected expressions for one of the two commute jobs, or identifies the mismatch without giving exact corrected cron expressions.
- 0.5: Agent notes the commute reminders may have timing issues but doesn't identify the specific bug or cite commute-config.json's reminderMinutesBefore value.
- 0.25: Agent mentions the commute jobs exist without identifying any timing issue.
- 0.0: No mention of commute timing, or agent incorrectly says the timing is correct.

### Cross-File Inconsistency Detection (Weight: 25%)
Evaluates whether the agent found both the maxContextTokens conflict and the security concern.

- 1.0: Agent identifies both issues: (a) maxContextTokens is 4096 in low-memory-config.json but 8192 in openclaw-config.json, causing the memory optimization to be effectively ignored; (b) `host: "0.0.0.0"` in openclaw-config.json exposes the server to public network access.
- 0.75: Agent identifies one of the two issues clearly.
- 0.5: Agent mentions both issues but without correctly identifying which files contain the conflicting values or what the actual security risk is.
- 0.25: Agent mentions inconsistencies in general without tracing them to specific files and values.
- 0.0: No cross-file inconsistencies identified.

### Reliability and Completeness Issues (Weight: 25%)
Evaluates whether the agent found the expired test task and the missing worklog files.

- 1.0: Agent identifies both: (a) the one-time test task (94de43f5) is expired — it was scheduled for 2026-02-06 and has `enabled: false`, should be cleaned up; (b) the Weekly Report job references `worklog-data.json` and `weekly-report-config.json` which don't exist in the workspace, causing silent failures every Friday.
- 0.75: Agent identifies one of the two issues with specific details.
- 0.5: Agent notes reliability issues but without linking to specific job IDs or missing file names.
- 0.25: Vague mention of potential issues without specifics.
- 0.0: No reliability issues identified.

### Report Quality and Actionability (Weight: 20%)
Evaluates whether the audit report is well-structured, accurate, and gives the user actionable next steps.

- 1.0: Report is clearly organized (e.g., per-issue sections or per-job status), correctly identifies what is working well (sitting reminders, weight tracking, memory monitor), provides specific fixes (corrected cron expressions, config value recommendations), and is immediately actionable.
- 0.75: Report is mostly organized and actionable; covers most issues with some specificity.
- 0.5: Report lists issues but is disorganized or lacks specific corrective actions.
- 0.25: Report is minimal — mentions some problems without useful structure or actionable guidance.
- 0.0: No report produced, or content is irrelevant.
