---
id: task_00081_feishu_task_progress_reporting_skill
name: Feishu Task Progress Reporting Skill
category: Communication and Scheduling
subcategory: Task and Plan Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: .env.feishu
  dest: .env.feishu
- source: feishu-config.json
  dest: feishu-config.json
- source: feishu-message-cache.json
  dest: feishu-message-cache.json
- source: tasks.json
  dest: tasks.json
- source: project-metadata.json
  dest: project-metadata.json
- source: team-contacts.csv
  dest: team-contacts.csv
- source: meeting-notes-2026-02-06.md
  dest: meeting-notes-2026-02-06.md
---

## Prompt

Hey, Wang Jun (sender: ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa04) just DMed me on Feishu asking "How is the progress on the three tasks?" — can you help me reply?

Before you write anything, please read through **all the workspace files** carefully, especially `feishu-message-cache.json` which has today's messages. Something about TASK-001 might need special attention.

I need you to do two things:

1. Create a reusable skill at `workspace/skills/task-progress-reporter/SKILL.md`. It should define a "task progress reporter" skill that reads structured task data, cross-references the message cache for late-breaking updates, detects blockers or schedule risks, and produces a Feishu-ready summary. Include sections for: when to use this skill, required inputs, processing steps (including how to handle conflicting data across sources), and output format.

2. Then use that skill: write a ready-to-send reply to `progress_report.md`. For each task include: title, assignee, status, progress %, due date, and a risk/blocker flag where relevant. Base the report on what you actually find across **all** the files — do not simply repeat numbers you've seen in one place; cross-check everything.

## Expected Behavior

The agent should:

1. **Read all seven workspace files**:
   - `tasks.json`: three in-progress tasks (TASK-001 72%, TASK-002 45%, TASK-003 30%), with task notes mentioning "MQ setup ETA Feb 11" for TASK-001's blocker.
   - `feishu-message-cache.json`: contains a **critical update from this morning** (2026-02-10T09:15) where Zhang Wei reports the RabbitMQ ETA has slipped to **Feb 13** (not Feb 11 as in tasks.json notes). Wang Jun then estimates "70% done overall" — which conflicts with the actual average.
   - `meeting-notes-2026-02-06.md`: notes from Feb 6 confirm the MQ dependency risk was already flagged ("If MQ setup slips, migration could miss Feb 14 deadline").
   - `project-metadata.json`: identifies sender `ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa04` as Wang Jun, Project Manager.
   - `team-contacts.csv`: 6 members total — 2 (Zhao Ling, Sun Hao) are **not** in project-metadata.json's team list.
   - `.env.feishu` and `feishu-config.json`: Feishu API context.

2. **Identify three data conflicts requiring resolution**:
   - **Conflict A (MQ timeline)**: `tasks.json` notes say "ETA Feb 11" but Zhang Wei's 09:15 message today says "new ETA is Feb 13". The message is more recent → use Feb 13 as authoritative.
   - **Conflict B (overall progress estimate)**: Wang Jun's 09:22 message says "about 70% done overall". Actual computed average: (72 + 45 + 30) / 3 = **49%**. The 70% figure is Wang Jun's uninformed guess; the report should use the correct 49% figure and not parrot the 70% estimate.
   - **Conflict C (team membership)**: `team-contacts.csv` has 6 people but `project-metadata.json` only lists 4 on the project team. Agent should use project-metadata.json as the authoritative team list for this project.

3. **Flag TASK-001 as AT RISK**: Due Feb 14; MQ (required dependency) now not ready until Feb 13. That leaves only 1 day for notification endpoint migration + API docs + integration testing — this is a critical timeline risk.

4. **Create `workspace/skills/task-progress-reporter/SKILL.md`** with:
   - YAML frontmatter (name, description fields)
   - A **Triggers / When to Use** section
   - An **Inputs** section listing required data sources (task JSON, message cache, project metadata)
   - A **Steps** section with numbered steps including: read task data → check message cache for late-breaking updates → resolve conflicts (latest message overrides task notes) → compute correct averages → identify blockers/risks → compose report
   - An **Output Format** section showing the report structure (per-task breakdown + risk flags + overall summary)

5. **Create `progress_report.md`** that:
   - Addresses Wang Jun by name
   - Lists all three tasks with title, assignee, status, progress %, due date
   - Flags TASK-001 as **AT RISK** with the Feb 13 MQ blocker and Feb 14 deadline noted
   - States the correct overall average (~49%), NOT Wang Jun's 70% estimate
   - Is friendly and concise — suitable for pasting into a Feishu DM reply

## Grading Criteria

- [ ] SKILL.md exists at `workspace/skills/task-progress-reporter/SKILL.md` with YAML frontmatter (name, description)
- [ ] SKILL.md contains a conflict-resolution step (latest message overrides stale task notes)
- [ ] progress_report.md exists and covers all three tasks with correct data (72%, 45%, 30%; correct due dates)
- [ ] progress_report.md flags TASK-001 as AT RISK / blocked (due to MQ delay)
- [ ] progress_report.md uses the MQ ETA of Feb 13 (not Feb 11 from tasks.json)
- [ ] progress_report.md does NOT parrot Wang Jun's incorrect 70% estimate; uses ~49% or correctly computed per-task figures
- [ ] Agent correctly identifies Wang Jun as the sender using project-metadata.json

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import re
    import glob
    from pathlib import Path

    ws = Path(workspace_path)
    scores = {
        "skill_md_structured": 0.0,
        "progress_report_data_accurate": 0.0,
        "mq_conflict_resolved": 0.0,
        "risk_flag_for_task001": 0.0,
        "progress_report_all_tasks": 0.0,
    }

    # --- Locate SKILL.md ---
    skill_path = None
    preferred = ws / "skills" / "task-progress-reporter" / "SKILL.md"
    if preferred.exists():
        skill_path = preferred
    else:
        matches = sorted(glob.glob(str(ws / "skills" / "*" / "SKILL.md")))
        if matches:
            skill_path = Path(matches[0])

    report_path = ws / "progress_report.md"

    if skill_path is None and not report_path.exists():
        return scores

    # --- SKILL.md check ---
    if skill_path is not None and skill_path.exists():
        try:
            skill_content = skill_path.read_text(encoding="utf-8", errors="replace")
            fm_match = re.search(r"^---\s*\n(.*?)\n---", skill_content, re.DOTALL)
            if fm_match:
                fm_text = fm_match.group(1)
                has_name = bool(re.search(r"(?i)name\s*:", fm_text))
                has_desc = bool(re.search(r"(?i)description\s*:", fm_text))
                body = skill_content[fm_match.end():]
                body_lower = body.lower()
                # Check for key sections
                has_steps = bool(re.search(r"step|procedure|process|workflow", body_lower))
                has_conflict = bool(re.search(r"conflict|override|latest|prioriti|cross.?ref|reconcil", body_lower))
                has_output = bool(re.search(r"output|format|template|report", body_lower))
                section_score = sum([has_steps, has_conflict, has_output])
                if has_name and has_desc and len(body.strip()) >= 100 and section_score >= 2:
                    scores["skill_md_structured"] = 1.0
                elif has_name and has_desc and len(body.strip()) >= 50:
                    scores["skill_md_structured"] = 0.6
                elif fm_match:
                    scores["skill_md_structured"] = 0.3
        except Exception:
            pass

    if not report_path.exists():
        return scores

    try:
        report = report_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return scores

    if len(report.strip()) < 20:
        return scores

    report_lower = report.lower()

    # --- All three tasks mentioned ---
    task_patterns = [
        r"TASK-001|Backend API migration|api.*v3|v3.*api",
        r"TASK-002|Mobile app UI|mobile.*redesign|UI redesign",
        r"TASK-003|User analytics|analytics dashboard",
    ]
    tasks_found = sum(1 for p in task_patterns if re.search(p, report, re.IGNORECASE))
    scores["progress_report_all_tasks"] = tasks_found / 3.0

    # --- Data accuracy: correct percentages and due dates ---
    accuracy = 0.0
    pct_checks = sum(1 for pct in ["72", "45", "30"] if re.search(rf"\b{pct}\s*%", report))
    accuracy += (pct_checks / 3.0) * 0.5
    date_checks = sum(1 for d in ["2026-02-14", "2026-02-20", "2026-02-25"] if d in report)
    accuracy += (date_checks / 3.0) * 0.5
    scores["progress_report_data_accurate"] = accuracy

    # --- KEY CHECK: Does the report use Feb 13 (not Feb 11) for MQ ETA? ---
    # And does it NOT repeat Wang Jun's wrong 70% as overall progress?
    has_feb13 = bool(re.search(r"feb\.?\s*13|2026-02-13|february\s+13", report_lower))
    has_feb11_only = bool(re.search(r"feb\.?\s*11|2026-02-11", report_lower)) and not has_feb13
    wrong_70_parroted = bool(re.search(r"(overall|average|avg|total).{0,40}\b70\s*%|\b70\s*%.{0,40}(overall|average|avg|total)", report_lower)) and not bool(
        re.search(r"(incorrect|wrong|not accurate|actually|correct[^i]|real|49\s*%|avg.*49|average.*49)", report_lower)
    )
    if has_feb13 and not wrong_70_parroted:
        scores["mq_conflict_resolved"] = 1.0
    elif has_feb13:
        scores["mq_conflict_resolved"] = 0.6
    elif not has_feb11_only and not wrong_70_parroted:
        scores["mq_conflict_resolved"] = 0.3

    # --- Risk flag for TASK-001 ---
    # Check for risk/blocker language near TASK-001 context
    risk_keywords = ["at risk", "risk", "blocked", "blocker", "critical", "deadline", "slip", "tight", "delay"]
    task001_context = re.search(
        r"(TASK-001|backend api|api.*v3|v3.*api).{0,400}",
        report, re.IGNORECASE | re.DOTALL
    )
    if task001_context:
        context_text = task001_context.group(0).lower()
        risk_found = sum(1 for kw in risk_keywords if kw in context_text)
        if risk_found >= 2:
            scores["risk_flag_for_task001"] = 1.0
        elif risk_found == 1:
            scores["risk_flag_for_task001"] = 0.5

    return scores
```

## LLM Judge Rubric

### Multi-Source Conflict Resolution (Weight: 35%)
Evaluates whether the agent identifies and correctly resolves the three data conflicts across workspace files.

- **1.0**: Correctly resolves all three conflicts: (A) uses MQ ETA of Feb 13 from Zhang Wei's morning message (not Feb 11 from tasks.json notes); (B) uses the actual computed average of ~49% and explicitly corrects or ignores Wang Jun's 70% estimate; (C) uses project-metadata.json team list as authoritative (4 members, not 6 from team-contacts.csv).
- **0.75**: Resolves conflicts A and B correctly; C may be missed or handled implicitly.
- **0.5**: Resolves conflict A (MQ ETA) correctly but accepts Wang Jun's 70% estimate without challenge, or vice versa.
- **0.25**: Notices some inconsistency but doesn't clearly resolve it — output contains mixed/ambiguous data.
- **0.0**: Ignores the message cache entirely; reports Feb 11 or parrots 70% as the overall progress; no cross-referencing.

### TASK-001 Risk Assessment (Weight: 25%)
Evaluates whether TASK-001 is correctly identified and flagged as AT RISK.

- **1.0**: Flags TASK-001 as AT RISK or blocked, explicitly notes the MQ ETA of Feb 13 vs Feb 14 deadline, explains only 1 day for remaining work (notification migration + API docs + integration testing), and recommends escalation or deadline review.
- **0.75**: Flags TASK-001 as risky and mentions the Feb 13/Feb 14 conflict, but doesn't detail the remaining work or recommend action.
- **0.5**: Notes that TASK-001 has a blocker but doesn't connect it to the deadline risk or uses the old Feb 11 ETA.
- **0.25**: Mentions notification endpoints are blocked but doesn't flag the timeline as at risk.
- **0.0**: No risk assessment; reports TASK-001 as normal in-progress without noting the blocker or deadline risk.

### Progress Report Accuracy and Completeness (Weight: 20%)
Evaluates whether progress_report.md accurately reflects all three tasks with correct data.

- **1.0**: All three tasks present with correct titles, progress percentages (72%, 45%, 30%), due dates (2026-02-14, 2026-02-20, 2026-02-25), assignees, and representative notes. Report correctly does not state 70% as overall average.
- **0.75**: All three tasks present with mostly correct data; one minor omission or note missing.
- **0.5**: All three tasks mentioned but one has incorrect data, or overall average is stated as 70% without correction.
- **0.25**: Only one or two tasks covered, or significant inaccuracies.
- **0.0**: Missing, empty, or fabricated task data.

### Skill Definition Quality (Weight: 20%)
Evaluates the SKILL.md quality.

- **1.0**: SKILL.md has proper YAML frontmatter (name, description), and clearly defined sections for: when to use the skill, required inputs (listing task JSON, message cache, project metadata), numbered processing steps that include a conflict-resolution rule (latest message overrides stale task notes), and an output format template.
- **0.75**: SKILL.md has frontmatter and most required sections, but the conflict-resolution step is absent or vague.
- **0.5**: SKILL.md exists with frontmatter and some content but is generic, missing conflict handling or output format.
- **0.25**: SKILL.md exists but is minimal or boilerplate with no skill-specific logic.
- **0.0**: SKILL.md missing, empty, or unrelated to task progress reporting.
