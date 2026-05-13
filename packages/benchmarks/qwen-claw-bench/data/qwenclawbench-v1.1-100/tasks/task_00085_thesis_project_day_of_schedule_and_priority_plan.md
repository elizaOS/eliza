---
id: task_00085_thesis_project_day_of_schedule_and_priority_plan
name: Thesis Project Day-of Schedule and Priority Plan
category: Communication and Scheduling
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: tasks/todo_list.json
  dest: tasks/todo_list.json
- source: tasks/deadlines.yaml
  dest: tasks/deadlines.yaml
- source: tasks/priority_matrix.csv
  dest: tasks/priority_matrix.csv
- source: tasks/old_schedule_v1.md
  dest: tasks/old_schedule_v1.md
- source: tasks/team_notes.txt
  dest: tasks/team_notes.txt
- source: tasks/advisor_requirements.md
  dest: tasks/advisor_requirements.md
- source: tasks/self_notes.md
  dest: tasks/self_notes.md
- source: resources/ppt_template_guide.md
  dest: resources/ppt_template_guide.md
- source: resources/thesis_outline_template.md
  dest: resources/thesis_outline_template.md
- source: logs/advisor_feedback.log
  dest: logs/advisor_feedback.log
- source: logs/submission_system_status.log
  dest: logs/submission_system_status.log
grading_weights:
  automated: 0.5
  llm_judge: 0.5
subcategory: Task and Plan Management
---
## Prompt

It's 8:00 AM on June 15th and I need a schedule I can actually trust for today's thesis submission push. My planning files do not agree with each other: some are old, some are informal notes, and my advisor added a few things this morning. I need one reliable plan plus a structured handoff I can use to track execution during the day.

Please:

1. Review the thesis-planning files in the workspace and reconcile them. For each task, determine the real current status (`done`, `in-progress`, or `not-started`) using the most authoritative and up-to-date sources. If files conflict, say which source wins and why.
2. Identify every task that still must happen today, including anything newly introduced in the advisor materials even if it is missing from the main tracker.
3. Validate the priority matrix instead of trusting its quadrant labels blindly. If a quadrant label disagrees with the urgency/importance scores, correct it and use the corrected priority in the plan.
4. Build a feasible time-blocked schedule for 08:00-15:00 that respects dependencies, meets every hard deadline, and is grouped into clear phases with key deliverables.
5. Confirm the real deadlines from the most authoritative source and explicitly reject stale ones.

Deliverables:

- Write the narrative plan to `project_plan_output.md`. It must include: task status summary, confirmed deadlines, phase-by-phase time-blocked schedule, key deliverables for each phase, conflicts/corrections with source-resolution reasoning, and priority classifications for remaining work.
- Also write `project_plan_summary.json` so I can quickly sanity-check the plan and reuse it in a checklist tool. Use these top-level keys: `confirmed_deadlines`, `tasks`, `schedule`, and `conflicts`.
- In `project_plan_summary.json`, each item in `tasks` must include `id`, `status`, `duration_minutes`, `priority`, and `depends_on`.
- In `project_plan_summary.json`, each item in `schedule` must include `phase`, `start`, `end`, `task_id`, and `deliverable`.
- The markdown and JSON outputs must agree.

## Expected Behavior

The agent should:

1. **Read and cross-reference the relevant planning files**, including `tasks/todo_list.json`, `tasks/deadlines.yaml`, `tasks/priority_matrix.csv`, `tasks/advisor_requirements.md`, `tasks/self_notes.md`, and the logs. The agent must also examine `tasks/old_schedule_v1.md` and `tasks/team_notes.txt` but identify them as outdated or unreliable sources where appropriate.

2. **Trap 1 — Outdated deadlines (old_schedule_v1.md vs. deadlines.yaml):** The file `tasks/old_schedule_v1.md` contains three deadline discrepancies compared to the authoritative `tasks/deadlines.yaml`:
   - Thesis submission deadline: **17:00** (old) vs. **15:00** (correct)
   - Defense PPT due: **16:00** (old) vs. **14:30** (correct)
   - Advisor review cutoff: **14:00** (old) vs. **13:00** (correct)

   All three discrepancies are critical. The old schedule also lists PPT creation as **45 minutes**, while `tasks/todo_list.json` correctly lists it as **120 minutes**. The agent must note all four discrepancies and explain that it trusts `deadlines.yaml` and `todo_list.json` as the current authoritative sources.

3. **Trap 2 — Contradictory task status (team_notes.txt vs. todo_list.json):** The file `tasks/team_notes.txt` states the thesis outline "still needs to be completed" and that the literature review "is fully finished." However, `tasks/todo_list.json` shows the outline as **done** (status: done) and the literature review as **in-progress**. The agent must use the statuses from `todo_list.json` and flag the team notes as containing outdated or incorrect status information.

4. **Trap 3 — False completion claims (self_notes.md vs. todo_list.json):** The file `tasks/self_notes.md` claims that the literature review is "100% done," that proofreading (T004) was completed last night, and that the abstract is "all good." It also claims T005 takes only 45 minutes and T003 can be reduced to 15 minutes. All of these are incorrect:
   - T002 (literature review) status is **in-progress** per `todo_list.json` (authoritative)
   - T004 (proofreading) status is **not-started** per `todo_list.json` (authoritative)
   - T001 (abstract) needs a final revision pass per today's advisor feedback log (07:45 entry)
   - T005 takes **120 minutes** (not 45) per `todo_list.json`
   - T003 requires the full **45 minutes** per `todo_list.json`

   The agent must recognize `self_notes.md` as an unreliable informal personal estimate and must not use any of its status or time claims.

5. **Trap 4 — Priority matrix quadrant errors (priority_matrix.csv):** The `tasks/priority_matrix.csv` file contains mislabeled quadrant values for four tasks:
   - T001: urgency=3, importance=4 → should be **Q2** (labeled as Q1 — incorrect)
   - T003: urgency=3, importance=3 → should be **Q2** (labeled as Q1 — incorrect)
   - T005: urgency=5, importance=5 → should be **Q1** (labeled as Q2 — incorrect, and dangerously misleading)
   - T008: urgency=2, importance=3 → should be **Q3** (labeled as Q1 — incorrect)

   The agent should verify quadrant assignments against the urgency/importance scores and note the discrepancies. Most critically, T005 must be recognized as Q1 (not Q2) — it is the highest-priority remaining deliverable. Blindly trusting the mislabeled quadrant for T005 could cause the agent to deprioritize it with catastrophic scheduling consequences.

6. **Trap 5 — Abstract revision and corrected T004 estimate (advisor_feedback.log and advisor_requirements.md):** Two sources provide updates that override information in `todo_list.json`:
   - `logs/advisor_feedback.log` entry from 07:45 today: The abstract (T001) needs a mandatory final revision pass, estimated at **20 minutes**. Although T001 is marked "done" in `todo_list.json`, the advisor's this-morning feedback is more recent and authoritative for today's plan — the abstract revision must be incorporated as a task.
   - `tasks/advisor_requirements.md` (and confirmed by the 07:52 log entry): The proofreading estimate must be corrected to **120 minutes**, not the 90 minutes in `todo_list.json`. The advisor's requirement document supersedes the tracker on this specific estimate.

7. **New mandatory task T009 — Data Sources Appendix:** `tasks/advisor_requirements.md` introduces a new mandatory task not found in `todo_list.json`: adding a **Data Sources Appendix** before PDF export. Estimated time: **30 minutes**. This task depends on proofreading (T004) being complete and must finish before PDF export (T008). The agent must include T009 in the plan and schedule it correctly.

8. **Correctly identify completed tasks:** T006 (Prepare thesis outline document — done). T001 is "done" in the tracker but requires a 20-minute revision pass today. All other tracked tasks (T002–T005, T007, T008) are remaining, plus T009 (new).

9. **Confirm the real deadlines from `tasks/deadlines.yaml`:**
   - Advisor review cutoff: 13:00
   - Defense PPT due: 14:30
   - Thesis submission deadline: 15:00
   - Current time: 08:00 (7 hours available)

10. **T005 dependency update:** `tasks/todo_list.json` now lists T005 (Create thesis defense PPT) as depending on both T001 and T002. The PPT cannot begin until the literature review is complete. The agent must respect this dependency.

11. **Build a feasible zero-margin time-blocked schedule.** With corrected estimates, the total time for all remaining work is exactly 420 minutes — precisely matching the available window. There is no buffer. The agent must produce a schedule that is both correct and tight. Key scheduling constraints:
    - T002 must be completed before T003 (reference formatting depends on it) and before T005 (PPT depends on it)
    - T007 (Submit to advisor, 15 min) depends on T004 and must be done before the 13:00 advisor review cutoff
    - T004 (Proofreading, **120 min**) depends on T002 and T003 — the corrected estimate is critical for a feasible schedule
    - T005 (PPT, 120 min) must finish by 14:30 and depends on T001 and T002
    - T009 (Data appendix, 30 min) depends on T004 and must complete before T008
    - T008 (Export PDF, 10 min) is the final step before 15:00

    One valid schedule (there may be other valid orderings):
    - 08:00–09:00: T002 (Complete literature review, 60 min remaining) ✓
    - 09:00–09:20: T001-revision (Abstract final revision per advisor feedback, 20 min) ✓
    - 09:20–10:05: T003 (Reference formatting, 45 min — after T002) ✓
    - 10:05–12:05: T004 (Proofreading, 120 min — after T002 and T003) ✓
    - 12:05–12:20: T007 (Submit to advisor, 15 min — after T004, before 13:00 cutoff) ✓
    - 12:20–14:20: T005 (Defense PPT creation, 120 min — after T001 and T002, finishes before 14:30) ✓
    - 14:20–14:50: T009 (Data Sources Appendix, 30 min — after T004) ✓
    - 14:50–15:00: T008 (Export PDF and submit, 10 min — final step, exactly at 15:00 deadline) ✓

12. **Ignore noise from logs** (`logs/advisor_feedback.log` pre-June-15 entries are historical context; `logs/submission_system_status.log` entries show portal is online but are not scheduling-relevant beyond confirming no outages). The June 15 entries in the feedback log are critical and must not be ignored.

13. **Write two aligned outputs.**
    - `project_plan_output.md` with sections: task status summary, confirmed deadlines, phase-by-phase time-blocked schedule with deliverables per phase, conflicts and corrections, and priority classification for all tasks.
    - `project_plan_summary.json` with:
      - `confirmed_deadlines`: object containing `advisor_review_cutoff`, `defense_ppt_due`, `thesis_submission`
      - `tasks`: array covering the resolved task list, with `id`, `status`, `duration_minutes`, `priority`, `depends_on`
      - `schedule`: array of ordered time blocks with `phase`, `start`, `end`, `task_id`, `deliverable`
      - `conflicts`: array of resolved discrepancies, each including the rejected source, trusted source, and reason
    - The two files must be mutually consistent.

## Grading Criteria

- [ ] Both `project_plan_output.md` and `project_plan_summary.json` exist and are mutually consistent
- [ ] Correctly identifies T006 (Prepare thesis outline document) as already completed
- [ ] Uses the correct thesis submission deadline of 15:00 (not 17:00 from the old schedule)
- [ ] Uses the correct advisor review cutoff of 13:00 (not 14:00 from the old schedule)
- [ ] Uses the correct defense PPT deadline of 14:30 (not 16:00 from the old schedule)
- [ ] Uses the correct PPT estimated duration of 120 minutes (not 45 minutes from old schedule or self_notes)
- [ ] Uses the corrected proofreading duration of 120 minutes for T004 (not 90 minutes from todo_list.json)
- [ ] Correctly identifies literature review (T002) as in-progress (not finished as self_notes and team_notes claim)
- [ ] Correctly identifies proofreading (T004) as not-started (not done as self_notes claims)
- [ ] Includes the new mandatory T009 Data Sources Appendix task in the plan
- [ ] Includes the abstract revision step in the schedule (based on advisor feedback log from 07:45 today)
- [ ] Explicitly flags and resolves at least four data conflicts between files, identifying which source was trusted and why
- [ ] Detects and corrects all four priority matrix quadrant errors (T001, T003, T005, T008)
- [ ] Includes all three key deadlines: advisor review cutoff (13:00), defense PPT due (14:30), thesis submission (15:00)
- [ ] Schedule respects all task dependencies — literature review completion precedes T003, T004, and T005
- [ ] T007 (submit to advisor) is scheduled before the 13:00 cutoff
- [ ] T005 (defense PPT) is scheduled to finish by 14:30
- [ ] T008 (export PDF) is scheduled as the final step before 15:00
- [ ] Schedule is organized into clear phases with at least one key deliverable identified per phase
- [ ] Priority classification is provided for all remaining tasks
- [ ] `project_plan_summary.json` contains machine-readable deadlines, task metadata, ordered schedule blocks, and resolved conflicts
- [ ] The schedule covers the full 08:00-15:00 window with effectively zero slack and no missing required task blocks

## Automated Checks

```python
import json
import re
from pathlib import Path


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _norm(value):
    return str(value).strip().lower()


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _time_to_minutes(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{2}:\d{2}", value):
        return None
    hours, minutes = map(int, value.split(":"))
    return hours * 60 + minutes


def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the thesis day-plan outputs using both markdown and structured JSON."""

    keys = [
        "plan_md_exists",
        "plan_json_exists",
        "deadlines_confirmed",
        "completed_task_identified",
        "t002_in_progress",
        "t004_not_started",
        "corrected_durations_applied",
        "t009_included",
        "abstract_revision_included",
        "priority_corrections_complete",
        "conflicts_resolved_with_authority",
        "schedule_has_phases_and_deliverables",
        "schedule_zero_margin_window",
        "dependencies_respected",
        "t007_before_cutoff",
        "t005_before_deadline",
        "t008_final_step",
        "markdown_sections_present",
    ]
    results = {key: 0.0 for key in keys}

    root = Path(workspace_path)
    md_path = root / "project_plan_output.md"
    json_path = root / "project_plan_summary.json"

    content = ""
    if md_path.is_file():
        results["plan_md_exists"] = 1.0
        content = md_path.read_text(encoding="utf-8", errors="replace")

    summary = None
    if json_path.is_file():
        results["plan_json_exists"] = 1.0
        summary = _load_json(json_path)

    if content:
        content_lower = content.lower()
        required_sections = [
            "task status",
            "confirmed deadlines",
            "schedule",
            "conflicts",
            "priority",
        ]
        section_hits = sum(1 for section in required_sections if section in content_lower)
        if section_hits >= 5:
            results["markdown_sections_present"] = 1.0
        elif section_hits >= 3:
            results["markdown_sections_present"] = 0.5

    if not isinstance(summary, dict):
        return results

    deadlines = summary.get("confirmed_deadlines", {})
    if isinstance(deadlines, dict):
        if (
            deadlines.get("advisor_review_cutoff") == "13:00"
            and deadlines.get("defense_ppt_due") == "14:30"
            and deadlines.get("thesis_submission") == "15:00"
        ):
            results["deadlines_confirmed"] = 1.0

    tasks = summary.get("tasks", [])
    task_map = {}
    if isinstance(tasks, list):
        for task in tasks:
            if isinstance(task, dict) and task.get("id"):
                task_map[str(task["id"])] = task

    if _norm(task_map.get("T006", {}).get("status")) == "done":
        results["completed_task_identified"] = 1.0
    if _norm(task_map.get("T002", {}).get("status")) == "in-progress":
        results["t002_in_progress"] = 1.0
    if _norm(task_map.get("T004", {}).get("status")) == "not-started":
        results["t004_not_started"] = 1.0

    corrected_duration = (
        _as_int(task_map.get("T004", {}).get("duration_minutes")) == 120
        and _as_int(task_map.get("T005", {}).get("duration_minutes")) == 120
    )
    if corrected_duration:
        results["corrected_durations_applied"] = 1.0

    t009 = task_map.get("T009", {})
    if isinstance(t009, dict) and _as_int(t009.get("duration_minutes")) == 30:
        results["t009_included"] = 1.0

    priority_ok = (
        _norm(task_map.get("T001", {}).get("priority")) == "q2"
        and _norm(task_map.get("T003", {}).get("priority")) == "q2"
        and _norm(task_map.get("T005", {}).get("priority")) == "q1"
        and _norm(task_map.get("T008", {}).get("priority")) == "q3"
    )
    if priority_ok:
        results["priority_corrections_complete"] = 1.0

    conflicts = summary.get("conflicts", [])
    valid_conflicts = []
    if isinstance(conflicts, list):
        for item in conflicts:
            if not isinstance(item, dict):
                continue
            if item.get("source_rejected") and item.get("source_trusted") and item.get("resolution_reason"):
                valid_conflicts.append(item)
        if len(valid_conflicts) >= 4:
            results["conflicts_resolved_with_authority"] = 1.0
        elif len(valid_conflicts) >= 2:
            results["conflicts_resolved_with_authority"] = 0.5

    schedule = summary.get("schedule", [])
    if not isinstance(schedule, list):
        return results

    normalized_schedule = []
    phase_deliverable_count = 0
    abstract_seen = False
    for item in schedule:
        if not isinstance(item, dict):
            continue
        start = _time_to_minutes(item.get("start"))
        end = _time_to_minutes(item.get("end"))
        task_id = str(item.get("task_id", ""))
        deliverable = str(item.get("deliverable", ""))
        if item.get("phase") and deliverable:
            phase_deliverable_count += 1
        if "t001" in task_id.lower() or "abstract" in deliverable.lower():
            abstract_seen = True
        if start is None or end is None or end <= start:
            continue
        normalized_schedule.append(
            {
                "task_id": task_id,
                "start": start,
                "end": end,
                "deliverable": deliverable,
            }
        )

    if abstract_seen:
        results["abstract_revision_included"] = 1.0

    if phase_deliverable_count == len(schedule) and len(schedule) >= 7:
        results["schedule_has_phases_and_deliverables"] = 1.0
    elif phase_deliverable_count >= max(len(schedule) - 1, 1):
        results["schedule_has_phases_and_deliverables"] = 0.5

    if normalized_schedule:
        normalized_schedule.sort(key=lambda item: item["start"])
        total_minutes = sum(item["end"] - item["start"] for item in normalized_schedule)
        contiguous = all(
            normalized_schedule[idx]["end"] == normalized_schedule[idx + 1]["start"]
            for idx in range(len(normalized_schedule) - 1)
        )
        if (
            normalized_schedule[0]["start"] == 8 * 60
            and normalized_schedule[-1]["end"] == 15 * 60
            and total_minutes == 420
            and contiguous
        ):
            results["schedule_zero_margin_window"] = 1.0

        first_start = {}
        last_end = {}
        for item in normalized_schedule:
            task_id = item["task_id"]
            first_start.setdefault(task_id, item["start"])
            last_end[task_id] = item["end"]

        def _task_present(*names):
            for name in names:
                if name in first_start:
                    return True
            return False

        def _end_of(*names):
            values = [last_end[name] for name in names if name in last_end]
            return max(values) if values else None

        def _start_of(*names):
            values = [first_start[name] for name in names if name in first_start]
            return min(values) if values else None

        dependency_ok = True
        pairs = [
            (("T002",), ("T003",)),
            (("T002",), ("T004",)),
            (("T002",), ("T005",)),
            (("T003",), ("T004",)),
            (("T004",), ("T007",)),
            (("T004",), ("T009",)),
            (("T009",), ("T008",)),
            (("T001", "T001-revision"), ("T005",)),
        ]
        for prereqs, downstream in pairs:
            prereq_end = _end_of(*prereqs)
            downstream_start = _start_of(*downstream)
            if prereq_end is None or downstream_start is None or prereq_end > downstream_start:
                dependency_ok = False
                break
        if dependency_ok:
            results["dependencies_respected"] = 1.0

        t007_end = _end_of("T007")
        if t007_end is not None and t007_end <= 13 * 60:
            results["t007_before_cutoff"] = 1.0

        t005_end = _end_of("T005")
        if t005_end is not None and t005_end <= 14 * 60 + 30:
            results["t005_before_deadline"] = 1.0

        t008_start = _start_of("T008")
        t008_end = _end_of("T008")
        if (
            t008_start is not None
            and t008_end is not None
            and normalized_schedule[-1]["task_id"] == "T008"
            and t008_end == 15 * 60
        ):
            results["t008_final_step"] = 1.0

    return results
```

## LLM Judge Rubric

### Criterion 1: Conflict Detection and Source Resolution Quality (Weight: 45%)
**Score 1.0**: The plan explicitly identifies all five major traps: (1) the multiple outdated deadlines in `old_schedule_v1.md` vs. `deadlines.yaml` (submission 17:00→15:00, advisor review 14:00→13:00, PPT due 16:00→14:30, plus PPT duration 45→120 min); (2) the contradictory task statuses in `team_notes.txt` vs. `todo_list.json` (outline done vs. "needs completion," literature review in-progress vs. "fully finished"); (3) the false completion claims in `self_notes.md` (T002, T004, T001 incorrectly marked as done, T005 underestimated); (4) the priority matrix quadrant errors (T003 Q2 not Q1, T005 Q1 not Q2, T008 Q3 not Q1, T001 Q2 not Q1); (5) the abstract needing a revision pass per today's advisor log despite T001 being "done" in the tracker, and the T004 estimate requiring correction from 90 to 120 min per advisor requirements. For each conflict the agent provides a clear, well-reasoned justification of why it trusts the authoritative source over the conflicting one.
**Score 0.75**: Four of the five traps are fully detected and resolved with reasonable justifications. All resolutions mentioned are correct. The missing trap is either entirely absent or acknowledged without clear resolution.
**Score 0.5**: Two to three traps are detected and resolved. The remaining traps are either missed or resolved without justification. The self_notes.md trap or the priority matrix errors are commonly missed at this level.
**Score 0.25**: Only one trap is detected and resolved. The plan may mention file inconsistencies in passing but does not systematically address them, and the agent may be partially misled by one or more trap files.
**Score 0.0**: No traps are detected. The agent silently blends conflicting information, trusts the wrong sources (e.g., accepts self_notes.md claims, uses 17:00 as the real deadline), or ignores file cross-referencing entirely.

### Criterion 2: Schedule Feasibility, Zero-Margin Precision, and Dependency Respect (Weight: 35%)
**Score 1.0**: The time-blocked schedule starts at 08:00 and places every task before its hard deadline, using the correct time estimates (T004 = 120 min, T005 = 120 min, T001 revision = ~20 min, T009 = 30 min). All task dependencies are respected: T002 precedes T003 and T005; T003 precedes T004; T004 precedes T007, T009, and T008; T007 is before 13:00; T005 finishes by 14:30; T009 completes before T008; T008 is the final step before 15:00. The plan acknowledges that there is virtually no schedule buffer and treats the timing constraints as hard constraints. T009 (Data Sources Appendix) is included as a mandatory item.
**Score 0.75**: The schedule respects all hard deadlines and most dependencies, includes T009, and uses mostly correct time estimates. Minor issues such as a small unexplained time gap, one dependency not explicitly called out (though respected in ordering), or the abstract revision included but placed in a slightly suboptimal slot that still works.
**Score 0.5**: The schedule generally fits within deadlines but has a notable flaw: either T009 is missing, or T004 is scheduled with the wrong estimate (90 min instead of 120 min) causing the schedule to appear less tight than it actually is, or one hard deadline is violated by a few minutes, or one dependency is clearly out of order.
**Score 0.25**: The schedule has multiple errors: T009 is missing AND T004 uses the wrong estimate, or T007 is scheduled after 13:00, or T005 is scheduled to finish after 14:30. The schedule would not be executable as written.
**Score 0.0**: No coherent time-blocked schedule is provided, or the schedule is fundamentally broken — for example, tasks are skipped because self_notes.md was trusted (T004 omitted entirely), deadlines from the old schedule are used (17:00 submission), or the schedule places tasks in dependency-violating order that makes key deadlines impossible to meet.

### Criterion 3: Delivery Usefulness and Structured Handoff Quality (Weight: 20%)
**Score 1.0**: The deliverable is execution-ready in both forms: `project_plan_output.md` is a concise but actionable planning document, and `project_plan_summary.json` is a clean machine-readable handoff that matches it. Phases, deadlines, deliverables, conflicts, and priorities are easy to audit. The zero-margin nature of the day is communicated clearly without hallucinated details.
**Score 0.75**: Both outputs are present and mostly aligned. The plan is usable, but one area is weaker than it should be, such as conflict explanations that are slightly thin, JSON that omits one non-critical field, or a priority section that is correct but not very systematic.
**Score 0.5**: The plan is understandable but one output is noticeably weaker: the markdown is useful but the JSON is incomplete, or the JSON is present but the markdown is hard to scan. Key facts are mostly correct, yet the handoff would still require manual cleanup before use.
**Score 0.25**: The deliverable is partially usable at best. One of the required outputs is missing, inconsistencies exist between the two outputs, or the structure is too messy to support confident execution under time pressure.
**Score 0.0**: The submission is not usable as a real same-day execution plan. Major sections are missing, the structured handoff is absent or invalid, or the content contains hallucinated or contradictory information.
