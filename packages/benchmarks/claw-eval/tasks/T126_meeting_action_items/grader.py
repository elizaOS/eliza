"""T126_meeting_action_items grader — English variant of T160zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T125zh_meeting_action_items")


class MeetingActionItemsGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _EXTRACTION_RUBRIC = """\
Evaluate the completeness of the assistant's action item extraction (0.0-1.0).

## 9 Action Items from 3 Meeting Notes
NOTE-301 (4 items):
1. Wang Ming — Q2 product roadmap document, due 3/28
2. Li Hua — Competitor new feature research report, due 3/30
3. Zhao Lei — Top 10 customer requirements list, due 3/27
4. Zhang Wei — Security compliance assessment report, due 3/31

NOTE-302 (3 items):
5. Li Hua — Microservice decomposition technical plan, due 4/3
6. Ma Qiang — Database migration test environment, due 3/28
7. Zhou Ming — Frontend component library upgrade to v3.0, due 4/5

NOTE-303 (2 items):
8. Wang Ming — Q1 technical team performance summary, due 3/29
9. Zhao Lei — Key customer renewal strategy proposal, due 3/30

## Strict Scoring
- 0.9-1.0: All 9 action items extracted, with assignee and due date
- 0.7-0.8: 7-8 extracted
- 0.4-0.6: 5-6 extracted
- 0.0-0.3: Fewer than 5 extracted
"""

    _DEDUP_RUBRIC = """\
Evaluate the accuracy of the assistant's deduplication matching between action items \
and to-dos (0.0-1.0).

## Correct 3 Fuzzy Matches
1. Action item "Q2 product roadmap document" (Wang Ming) <-> TODO-401 "Complete product roadmap" (Wang Ming)
   Match basis: same assignee + same topic + same due date
2. Action item "Top 10 customer requirements list" (Zhao Lei) <-> TODO-402 "Compile customer requirements" (Zhao Lei)
   Match basis: same assignee + overlapping topic + same due date
3. Action item "Database migration test environment" (Ma Qiang) <-> TODO-403 "DB migration test environment setup" (Ma Qiang)
   Match basis: same assignee + same topic (DB = database) + same due date

## Should Not Match
- TODO-404 (standup) and TODO-405 (deployment docs) are unrelated to any action item
- The remaining 6 action items have no corresponding to-do

## Strict Scoring
- 0.9-1.0: All 3 matches correct, no false matches
- 0.6-0.8: 2 correct
- 0.3-0.5: 1 correct
- 0.0-0.2: Matches incorrect or deduplication not performed
"""

    _RECOMMENDATION_RUBRIC = """\
Evaluate the completeness of new to-do suggestions (0.0-1.0).

## 6 New To-Dos Needed
1. Li Hua — Competitor research report (due 3/30, source NOTE-301)
2. Zhang Wei — Security compliance assessment (due 3/31, source NOTE-301)
3. Li Hua — Microservice decomposition plan (due 4/3, source NOTE-302)
4. Zhou Ming — Frontend component library upgrade (due 4/5, source NOTE-302)
5. Wang Ming — Q1 performance summary (due 3/29, source NOTE-303)
6. Zhao Lei — Renewal strategy proposal (due 3/30, source NOTE-303)

## Suggestions Should Include
- Assignee, due date, source meeting
- Suggested priority

## Strict Scoring
- 0.9-1.0: All 6 new suggestions listed with complete information
- 0.6-0.8: 4-5 listed
- 0.3-0.5: 2-3 listed
- 0.0-0.2: Fewer than 2 suggestions
"""
