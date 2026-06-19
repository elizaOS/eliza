"""T124_todo_calendar_conflict grader — English variant of T158zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T123zh_todo_calendar_conflict")


class TodoCalendarConflictGrader(_Base):  # type: ignore[misc]
    """English grader for T159: detect conflicts between todo deadlines and calendar events.

    Inherits scoring logic from T158zh and overrides only Chinese rubric strings.
    """

    _CONFLICT_RUBRIC = """\
Evaluate the accuracy of the assistant's todo-calendar conflict identification (0.0-1.0).

## 3 conflict groups that must be identified

Conflict 1 -- 3/27 full-day training (9:00-17:00):
- TODO-301 Q1 summary report (high) due 3/27 -> full day occupied, cannot be completed
- TODO-304 Reply to supplier quotes (medium) due 3/27 -> also cannot be completed
- Severity: High (2 todos, including 1 high priority)

Conflict 2 -- 3/28 afternoon all-hands meeting (14:00-17:00):
- TODO-302 Submit budget approval form (high) due 3/28 -> afternoon occupied, only morning available
- TODO-307 Read technical articles (low) due 3/28 -> minor conflict
- Severity: Medium (3 morning hours can complete budget form)

Conflict 3 -- 3/30 full-day business trip:
- TODO-303 Prepare client PPT (high) due 3/30 -> full-day trip prevents PPT work
- Severity: High (PPT must be completed in advance)

## Strict scoring
- 0.9-1.0: All 3 conflict groups correctly identified, priorities clearly annotated
- 0.7-0.8: All 3 identified but missing details
- 0.4-0.6: 2 groups identified
- 0.0-0.3: Fewer than 2 groups identified
"""

    _RESOLUTION_RUBRIC = """\
Evaluate the reasonableness and feasibility of rescheduling suggestions (0.0-1.0).

## Reasonable rescheduling plan
1. TODO-301 (Q1 report, 4h, high) -> move to 3/26 to complete
2. TODO-304 (supplier quotes, 2h, medium) -> move to 3/26 or 3/28 morning
3. TODO-302 (budget form, 3h, high) -> prioritize completion on 3/28 morning
4. TODO-303 (client PPT, 5h, high) -> must be completed on 3/29
   Note: 3/29 afternoon has tech sharing (14:00-15:30), work in morning + continue after sharing session
5. TODO-307 (technical articles, 2h, low) -> can be deferred to 3/29 or 3/31

## Evaluation criteria
- Whether estimated_hours for each todo are considered
- Whether high priority todos are prioritized
- Whether target dates are checked for conflicts as well
- Whether suggestions are specific and actionable (not vague)

## Strict scoring
- 0.9-1.0: Plan complete, feasible, considers priority and time constraints
- 0.6-0.8: Plan generally reasonable, some details lacking
- 0.3-0.5: Suggestions provided but don't account for real constraints
- 0.0-0.2: No suggestions given or suggestions infeasible
"""

    _COMPLETENESS_RUBRIC = """\
Evaluate the coverage and logical consistency of the suggestions (0.0-1.0).

## Complete output should include
1. Conflict list (date / todo / calendar event / severity)
2. Rescheduling suggestion for each conflict
3. Revised schedule after rescheduling (ensuring no new conflicts are created)
4. Priority explanation for each todo
5. Brief notes on non-conflicting todos as well

## Strict scoring
- 0.9-1.0: All 5 elements included, logically consistent
- 0.6-0.8: 3-4 elements included
- 0.3-0.5: 1-2 elements included
- 0.0-0.2: Output incomplete
"""
