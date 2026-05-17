"""T04en_todo_management grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T007zh_todo_management")


class TodoManagementGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    # ------------------------------------------------------------------ #
    # LLM Judge rubrics (English)
    # ------------------------------------------------------------------ #

    _DEDUP_ANALYSIS_RUBRIC = """\
Evaluate the agent's analysis quality in identifying duplicate to-do items.

The to-do list contains two genuine duplicate pairs:
1. todo_001 and todo_002: Both are "Complete Q1 Report", but with different \
due dates (03-05 vs 03-07)
2. todo_004 and todo_006: Both are "API Docs" related tasks (may differ in \
case/spacing)

There is also a false positive trap:
- todo_011 ("Review Q1 Statements") has a similar name to todo_001/002 but \
is a different task ("review" ≠ "complete")
- The agent should correctly identify it as NOT a duplicate

The agent should also notice:
- The Q1 Report duplicate pair has a due date conflict (03-05 vs 03-07) that \
needs to be flagged or resolved

Scoring:
- 0.9-1.0: Correctly identified both duplicate pairs, flagged the date conflict, \
and explicitly excluded todo_011 as a false positive
- 0.7-0.8: Identified both pairs but missed date conflict or false positive reasoning
- 0.5-0.6: Only identified one pair, or identified both but analysis unclear
- 0.2-0.4: Mentioned duplicates but analysis confused, or incorrectly merged \
the false positive
- 0.0-0.1: No duplicate analysis at all"""

    _ORGANIZATION_RUBRIC = """\
Evaluate the agent's organization and structuring of the to-do list.

Good to-do organization should include:
1. Grouping by urgency/timeline (e.g., due today, due this week, overdue)
2. Flagging overdue/expired tasks
3. Clear priority or categorization structure
4. Explaining what actions were taken (which items merged, which flagged)

Scoring:
- 0.9-1.0: Clear grouping structure, overdue items flagged, specific actions explained
- 0.6-0.8: Basic organization but some aspect incomplete (e.g., missing overdue \
flags or action summary)
- 0.3-0.5: Simple list without meaningful organization
- 0.0-0.2: No organization of tasks at all"""
