---
id: task_00084_project_task_scheduling_optimization_with_resource_constraints
name: Project Task Scheduling Optimization with Resource Constraints
category: Communication and Scheduling
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: project/tasks.json
  dest: project/tasks.json
- source: project/dependencies.yaml
  dest: project/dependencies.yaml
- source: project/resources.csv
  dest: project/resources.csv
- source: project/previous_schedule_v1.csv
  dest: project/previous_schedule_v1.csv
- source: project/notes/manager_email.txt
  dest: project/notes/manager_email.txt
- source: project/notes/meeting_notes_20240115.md
  dest: project/notes/meeting_notes_20240115.md
- source: project/config/scheduler_settings.ini
  dest: project/config/scheduler_settings.ini
- source: project/historical_estimates.csv
  dest: project/historical_estimates.csv
- source: project/team_capacity.json
  dest: project/team_capacity.json
- source: project/README.md
  dest: project/README.md
grading_weights:
  automated: 0.5
  llm_judge: 0.5
subcategory: Task and Plan Management
---
## Prompt

We're trying to nail down the schedule for our next development sprint and I need a fresh pair of eyes on this. All the relevant project files are in the `project/` directory — task definitions, dependency graph, resource info, some older schedule attempts, notes from the team, historical data, the works.

Here's what I need: build an optimal schedule that minimizes the total project completion time (makespan), respecting all task dependencies and the constraint that we have two workers who can each only handle one task at a time. I want you to go through everything in the project folder, figure out the right inputs, and produce a clean schedule.

For the output, please write `schedule_result.md` with the following:

- A summary of each task's duration and its dependencies (as you determined them from the project files)
- The critical path through the dependency graph and its total length
- A complete assignment table showing: task, assigned worker, start time (hour), end time (hour)
- The overall makespan
- A brief explanation of why this schedule is optimal given the constraints

Be careful with the data — I know there are a few older files floating around in there and some notes from the team. Make sure you're working from the authoritative sources. The README should help orient you on which files to trust.

## Expected Behavior

The agent must produce an optimal resource-constrained schedule by correctly navigating multiple data sources, some of which contain conflicting or misleading information.

**Correct Task Durations (from `project/tasks.json`):**
- A = 3 hours, B = 2 hours, C = 4 hours, D = 2 hours, E = 1 hour, F = 3 hours

**Correct Dependencies (from `project/dependencies.yaml`):**
- A: no prerequisites
- B: depends on A
- C: depends on A
- D: depends on B
- E: depends on C
- F: depends on D AND E

**Resource Constraints (from `project/resources.csv` and `project/team_capacity.json`):**
- 2 workers, each handling 1 task at a time

**Data Source Validation:**

1. **Outdated Schedule Awareness (`project/previous_schedule_v1.csv`):** The agent must correctly identify task durations by cross-referencing sources, resolving any inconsistencies in favor of the authoritative `project/tasks.json`. Earlier schedule artifacts may contain stale duration values that do not match the canonical source.

2. **Dependency Specification Accuracy (`project/notes/manager_email.txt`):** The agent must determine the correct dependency graph from the authoritative `project/dependencies.yaml`. Informal team communications may reference superseded decisions; the agent should use the YAML specification as the definitive dependency source.

3. **Unit Consistency Verification (`project/historical_estimates.csv`):** The agent must verify that data values are in consistent units before incorporating them. Any historical data file whose values appear inconsistent with the authoritative task specifications should be discarded or treated as unreliable.

**Critical Path Analysis:**
The dependency graph has these paths to F:
- A → B → D → F: 3 + 2 + 2 + 3 = 10 hours
- A → C → E → F: 3 + 4 + 1 + 3 = 11 hours

The critical path is **A → C → E → F** with a length of **11 hours**.

**Optimal Schedule (makespan = 11 hours):**

With 2 workers, one optimal assignment is:

| Task | Worker  | Start | End |
|------|---------|-------|-----|
| A    | Worker1 | 0     | 3   |
| B    | Worker1 | 3     | 5   |
| C    | Worker2 | 3     | 7   |
| D    | Worker1 | 5     | 7   |
| E    | Worker2 | 7     | 8   |
| F    | Worker1 | 8     | 11  |

(Worker assignments may vary, but the makespan must be 11 hours. F cannot start until both D and E are complete. D finishes at hour 7, E finishes at hour 8, so F starts at hour 8.)

The agent should clearly identify the critical path as A → C → E → F = 11 hours and produce a schedule with makespan = 11.

## Grading Criteria

- [ ] **task_c_duration_correct**: The agent correctly identifies task C's duration as 4 hours (from tasks.json), not 3 hours from the old schedule
- [ ] **dependency_f_correct**: The agent correctly identifies that task F depends on BOTH D and E (from dependencies.yaml), not just D as the manager email suggests
- [ ] **c_duration_not_3**: The agent does NOT state task C's duration as 3 hours; if the output explicitly uses C = 3 h (from the stale previous_schedule_v1.csv) this check scores 0.0 (exclusive penalty)
- [ ] **critical_path_mention**: The agent correctly identifies the critical path as A → C → E → F with a total length of 11 hours
- [ ] **minimum_makespan**: The output schedule has a makespan (total project completion time) of exactly 11 hours
- [ ] **f_start_at_8**: Task F correctly starts at hour 8 in the schedule; a start of hour 7 indicates the agent incorrectly accepted the email's claim that the E→F dependency was removed, scoring 0.0 (exclusive penalty)
- [ ] **task_f_end_time**: Task F correctly ends at hour 11 in the schedule
- [ ] **two_workers_used**: The resource constraint is respected (the schedule uses 2 workers and no worker is assigned two overlapping tasks)
- [ ] **no_historical_durations**: The output does NOT use minute-scale duration values from historical_estimates.csv (A=180, B=120, C=240, D=120, E=60, F=180) as task hours; using any such value scores 0.0 (exclusive penalty); explicitly noting the unit mismatch scores 1.0
- [ ] **critical_path_acef**: The agent correctly names all four nodes of the critical path (A, C, E, F) together in a critical-path context; all four nodes scores 1.0, three nodes scores 0.75, two nodes scores 0.5
- [ ] **file_exists_check**: The output file schedule_result.md exists

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the schedule_result.md output file."""
    results = {
        "file_exists_check": 0.0,
        "minimum_makespan": 0.0,
        "f_start_at_8": 0.0,
        "critical_path_mention": 0.0,
        "task_f_end_time": 0.0,
        "dependency_f_correct": 0.0,
        "task_c_duration_correct": 0.0,
        "two_workers_used": 0.0,
        "no_historical_durations": 0.0,
        "critical_path_acef": 0.0,
        "c_duration_not_3": 0.0,
    }

    output_file = Path(workspace_path) / "schedule_result.md"

    # file_exists_check: The output file schedule_result.md was created
    if not output_file.exists():
        return results

    results["file_exists_check"] = 1.0

    content = output_file.read_text(encoding="utf-8", errors="replace")

    # Check for blank content
    if not content or content.strip() == "":
        return results

    content_lower = content.lower()

    # ---------------------------------------------------------------
    # minimum_makespan: The optimal makespan is 11 hours
    # Partial credit: 0.75 for makespan=12
    # ---------------------------------------------------------------
    makespan_patterns_11 = [
        r'makespan[^.]*?\b11\b',
        r'\b11\b[^.]*?makespan',
        r'total[^.]*?\b11\b[^.]*?hour',
        r'\b11\b[^.]*?hour[^.]*?total',
        r'completion[^.]*?\b11\b',
        r'\b11\b[^.]*?completion',
        r'project\s+duration[^.]*?\b11\b',
        r'minimum[^.]*?\b11\b',
        r'\b11\b[^.]*?minimum',
        r'optimal[^.]*?\b11\b',
        r'\b11\s*hours?\b',
    ]
    for pat in makespan_patterns_11:
        if re.search(pat, content_lower):
            results["minimum_makespan"] = 1.0
            break

    if results["minimum_makespan"] == 0.0:
        makespan_patterns_12 = [
            r'makespan[^.]*?\b12\b',
            r'\b12\b[^.]*?makespan',
            r'total[^.]*?\b12\b[^.]*?hour',
            r'\b12\b[^.]*?hour[^.]*?total',
        ]
        for pat in makespan_patterns_12:
            if re.search(pat, content_lower):
                results["minimum_makespan"] = 0.75
                break

    # ---------------------------------------------------------------
    # f_start_at_8: Task F must start at hour 8 (not hour 7)
    # EXCLUSIVE: F starting at hour 7 means the agent accepted the manager
    # email's claim that E is no longer a prerequisite of F → score 0.0
    # ---------------------------------------------------------------
    f_start_7_patterns = [
        r'\bF\b.*\|\s*7\s*\|',
        r'\|\s*F\s*\|[^|]*\|\s*7\s*\|',
        r'\bF\b[^.]*\bstart[^.]*\b7\b',
        r'\bF\b[^.]*\b7\b[^.]*\bstart',
        r'[Tt]ask\s+F[^.]*:\s*7\b',
    ]
    f_start_8_patterns = [
        r'\bF\b.*\|\s*8\s*\|',
        r'\|\s*F\s*\|[^|]*\|\s*8\s*\|',
        r'\bF\b[^.]*\bstart[^.]*\b8\b',
        r'\bF\b[^.]*\b8\b[^.]*\bstart',
        r'[Ff]\s*starts?\s+at\s+(hour\s+)?8\b',
        r'\bF\b.*\b8\b.*\b11\b',
    ]
    f_start_7 = any(re.search(p, content) for p in f_start_7_patterns)
    f_start_8 = any(re.search(p, content) for p in f_start_8_patterns)

    if f_start_7 and not f_start_8:
        results["f_start_at_8"] = 0.0  # EXCLUSIVE: fell for email trap
    elif f_start_8:
        results["f_start_at_8"] = 1.0
    else:
        results["f_start_at_8"] = 0.5  # F mentioned but start time unclear

    # ---------------------------------------------------------------
    # critical_path_mention: Output identifies/discusses the critical path
    # Partial credit: 0.5 for mentioning "critical" without full analysis
    # ---------------------------------------------------------------
    if re.search(r'critical\s+path', content_lower):
        results["critical_path_mention"] = 1.0
    elif re.search(r'\bcritical\b', content_lower):
        results["critical_path_mention"] = 0.5

    # ---------------------------------------------------------------
    # task_f_end_time: Task F ends at hour 11 in the optimal schedule
    # ---------------------------------------------------------------
    if re.search(r'F.*\b11\b', content):
        results["task_f_end_time"] = 1.0

    # ---------------------------------------------------------------
    # dependency_f_correct: F depends on both D and E (not just D)
    # Partial credit: 0.75 for F with D,E (comma); 0.5 for D and E near F
    # ---------------------------------------------------------------
    paragraphs = re.split(r'\n\s*\n', content)
    for para in paragraphs:
        has_f = re.search(r'\bF\b', para) is not None
        has_d_and_e = re.search(r'\bD\s+and\s+E\b', para) is not None
        has_d_comma_e = re.search(r'\bD\s*,\s*E\b', para) is not None
        if has_f and has_d_and_e:
            results["dependency_f_correct"] = 1.0
            break
        elif has_f and has_d_comma_e:
            results["dependency_f_correct"] = 0.75
        elif has_f and re.search(r'\bD\b', para) and re.search(r'\bE\b', para):
            if results["dependency_f_correct"] < 0.5:
                results["dependency_f_correct"] = 0.5

    # ---------------------------------------------------------------
    # task_c_duration_correct: Task C is correctly identified as 4 hours
    # Partial credit: 0.5 for C with hours context but no explicit 4
    # ---------------------------------------------------------------
    for para in paragraphs:
        has_c = re.search(r'\bC\b', para) is not None
        has_4 = re.search(r'\b4\b', para) is not None
        has_hour = re.search(r'\bhours?\b', para.lower()) is not None
        if has_c and has_4:
            results["task_c_duration_correct"] = 1.0
            break
        elif has_c and has_hour and results["task_c_duration_correct"] == 0.0:
            results["task_c_duration_correct"] = 0.5

    # ---------------------------------------------------------------
    # two_workers_used: The schedule uses 2 workers/persons in parallel
    # Partial credit: 0.75 for Worker1/Worker2 labels; 0.5 for any worker mention
    # ---------------------------------------------------------------
    if re.search(r'(two|2)\s+(workers?|persons?|resources?)', content_lower):
        results["two_workers_used"] = 1.0
    elif re.search(r'workers?\s*[:\-]?\s*(worker1|worker2)', content_lower):
        results["two_workers_used"] = 0.75
    elif re.search(r'[Ww]orker|[Pp]erson|[Rr]esource', content):
        results["two_workers_used"] = 0.5

    # ---------------------------------------------------------------
    # no_historical_durations: Output does NOT use minute-scale values from
    # historical_estimates.csv (A=180, B=120, C=240, D=120, E=60, F=180)
    # EXCLUSIVE: using any such value as hours → 0.0
    # Explicitly noting the unit mismatch → 1.0
    # Correct durations used without mention → 0.75
    # ---------------------------------------------------------------
    minute_trap_patterns = [
        r'\bA\b[^.]*\b180\b[^.]*\bhour',
        r'\bB\b[^.]*\b120\b[^.]*\bhour',
        r'\bC\b[^.]*\b240\b[^.]*\bhour',
        r'\bD\b[^.]*\b120\b[^.]*\bhour',
        r'\bE\b[^.]*\b60\b[^.]*\bhour',
        r'\bF\b[^.]*\b180\b[^.]*\bhour',
        r'makespan[^.]*\b(300|360|420|480|540|600)\b',
    ]
    minute_trap_triggered = any(re.search(p, content_lower) for p in minute_trap_patterns)
    unit_mismatch_noted = bool(re.search(
        r'(historical[^.]*minute|minute[^.]*historical|duration.*minute.*hour|'
        r'mislabel|unit\s+mismatch|values.*in\s+minutes|minutes.*labeled.*hours)',
        content_lower
    ))

    if minute_trap_triggered:
        results["no_historical_durations"] = 0.0  # EXCLUSIVE: fell for trap 3
    elif unit_mismatch_noted:
        results["no_historical_durations"] = 1.0  # Explicitly caught the unit error
    else:
        results["no_historical_durations"] = 0.75  # Correct durations, trap not discussed

    # ---------------------------------------------------------------
    # critical_path_acef: Output correctly identifies all four nodes of
    # the critical path A→C→E→F together in a critical-path context
    # 4 nodes → 1.0; 3 nodes → 0.75; 2 nodes → 0.5
    # Also awards 1.0 for explicit arrow notation A→C→E→F
    # ---------------------------------------------------------------
    best_cp = 0.0
    for para in paragraphs:
        if re.search(r'critical', para.lower()):
            nodes_found = sum([
                bool(re.search(r'\bA\b', para)),
                bool(re.search(r'\bC\b', para)),
                bool(re.search(r'\bE\b', para)),
                bool(re.search(r'\bF\b', para)),
            ])
            if nodes_found == 4:
                best_cp = 1.0
                break
            elif nodes_found == 3:
                best_cp = max(best_cp, 0.75)
            elif nodes_found == 2:
                best_cp = max(best_cp, 0.5)
    if re.search(r'\bA\b\s*[→\->]+\s*\bC\b\s*[→\->]+\s*\bE\b\s*[→\->]+\s*\bF\b', content):
        best_cp = 1.0
    results["critical_path_acef"] = best_cp

    # ---------------------------------------------------------------
    # c_duration_not_3: Task C's duration must NOT be stated as 3 hours
    # EXCLUSIVE: C = 3 h means the agent used stale previous_schedule_v1.csv
    # → 0.0; explicit C = 4 h → 1.0; otherwise → 0.5
    # ---------------------------------------------------------------
    c_as_3_patterns = [
        r'\bC\b[^.]*\b3\b[^.]*\bhour',
        r'\bhour[^.]*\b3\b[^.]*\bC\b',
        r'[Tt]ask\s+C[^.]*:\s*3\b',
        r'\|\s*C\s*\|[^|]*\|\s*3\s*\|',
        r'\bC\s*=\s*3\b',
        r'\bC:\s*3\s*h',
    ]
    c_as_4_patterns = [
        r'\bC\b[^.]*\b4\b[^.]*\bhour',
        r'[Tt]ask\s+C[^.]*:\s*4\b',
        r'\|\s*C\s*\|[^|]*\|\s*4\s*\|',
        r'\bC\s*=\s*4\b',
        r'\bC:\s*4\s*h',
    ]
    c_is_3 = any(re.search(p, content) for p in c_as_3_patterns)
    c_is_4 = any(re.search(p, content) for p in c_as_4_patterns)

    if c_is_3 and not c_is_4:
        results["c_duration_not_3"] = 0.0  # EXCLUSIVE: fell for trap 1
    elif c_is_4:
        results["c_duration_not_3"] = 1.0
    else:
        results["c_duration_not_3"] = 0.5  # C present but duration unclear

    return results
```

## LLM Judge Rubric

### Criterion 1: Trap Detection and Data Source Reasoning (Weight: 40%)
**Score 1.0**: The output explicitly identifies all three traps (outdated schedule with C=3h, manager email claiming F→E dependency removed, historical estimates with unit mismatch) and provides clear reasoning for why each was rejected in favor of the authoritative sources. The agent demonstrates a deliberate methodology for determining which files to trust (e.g., referencing the README's guidance) and articulates why `tasks.json` and `dependencies.yaml` are canonical.
**Score 0.75**: The output explicitly identifies and correctly resolves at least two of the three traps with clear reasoning. The third trap may be implicitly handled (correct data used) but without explicit discussion of why the conflicting source was rejected. General awareness of data conflict resolution is evident.
**Score 0.5**: The output explicitly identifies and resolves at least one trap with reasoning, and uses correct data throughout (suggesting the other traps were navigated), but lacks explicit discussion of the data conflicts for two or more traps. The reasoning for source prioritization is superficial or absent.
**Score 0.25**: The output arrives at mostly correct data but shows no explicit awareness of conflicting sources or traps. There is no discussion of why certain files were trusted over others, suggesting the agent may have gotten lucky or only read the correct files without critical evaluation.
**Score 0.0**: The output falls for one or more traps (e.g., uses C=3h, removes E dependency from F, or uses minute-scale durations), or shows no evidence of evaluating data source reliability.

### Criterion 2: Scheduling Logic and Analytical Depth (Weight: 35%)
**Score 1.0**: The output demonstrates thorough scheduling analysis including: enumeration of all dependency paths (identifying A→C→E→F = 11 h as the critical path and A→B→D→F = 10 h as the shorter path), correct critical path identification with awareness that 2 workers are sufficient to achieve the 11-hour critical path length without extension, clear step-by-step construction of the schedule showing how worker assignments were decided at each time slot, and a compelling optimality argument that addresses why no rearrangement could reduce the makespan below 11 hours (i.e., the critical path itself is the lower bound and the 2-worker constraint does not force a longer total duration).
**Score 0.75**: The output provides correct critical path analysis and a well-constructed schedule with a sound optimality argument, but is missing one element of depth (e.g., does not enumerate all dependency paths, or the optimality proof is correct but brief, or the relationship between the critical path length and the achievable makespan is not fully explained).
**Score 0.5**: The output provides a correct schedule and mentions the critical path, but the analysis is shallow — for example, the optimality justification is asserted rather than proven, or the interaction between resource constraints and the critical path is not clearly explained. The reasoning is correct but incomplete.
**Score 0.25**: The output presents a schedule but with weak or flawed analytical reasoning. The critical path discussion may be confused, the optimality argument may be missing or incorrect, or the relationship between dependencies and resource constraints is poorly articulated.
**Score 0.0**: The output lacks meaningful scheduling analysis, presents no critical path discussion, or contains fundamentally flawed reasoning about dependencies or resource constraints.

### Criterion 3: Professional Quality and Communication Clarity (Weight: 25%)
**Score 1.0**: The output is well-organized with clear section headers, a readable and well-formatted assignment table, precise language, and a logical flow from data summary → dependency analysis → critical path → schedule → optimality justification. The document would be immediately useful to a project manager without further clarification needed.
**Score 0.75**: The output is well-organized and clearly written with all required sections present and readable, but has minor issues such as slightly awkward formatting, a table that could be cleaner, or one section that could be more concise or better positioned in the document flow.
**Score 0.5**: The output contains all necessary information but is poorly organized, has formatting issues that hinder readability (e.g., misaligned tables, inconsistent notation), or presents information in a confusing order that requires re-reading to follow the logic.
**Score 0.25**: The output is disorganized, missing significant structural elements, or written in a way that is difficult to follow. Key information may be buried or presented without adequate context.
**Score 0.0**: The output is unstructured, incoherent, or so poorly formatted that it would not be usable as a professional deliverable.