"""T136_weekly_meeting_tracking grader — English variant of T170zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T135zh_weekly_meeting_tracking")


class WeeklyMeetingTrackingGrader(_Base):  # type: ignore[misc]
    """English grader for T171: track action items from weekly meetings against todos.

    Inherits scoring logic from T170zh and overrides only Chinese rubric strings.
    """

    _TRACKING_RUBRIC = """\
Evaluate the accuracy of action item status tracking (0.0-1.0).

## Correct status for all 8 action items
NOTE-501 (Product Weekly Meeting 3/16):
1. Wang Ming - Requirements prioritization -> TODO-501 completed
2. Li Hua - Microservices evaluation -> TODO-502 in_progress
3. Zhao Lei - Customer feedback -> TODO-503 completed

NOTE-502 (Technical Review 3/18):
4. Li Hua - API gateway design -> TODO-504 in_progress
5. Ma Qiang - Stress testing -> TODO-505 completed
6. Zhou Ming - Frontend optimization -> TODO-506 pending (overdue, due 3/24)

NOTE-503 (Customer Progress 3/20):
7. Zhao Lei - Dingxin contract -> TODO-507 pending
8. Wang Ming - Wantong POC -> No corresponding to-do (missing)

## Summary: completed=3, in_progress=2, pending=2, missing=1

## Strict scoring
- 0.9-1.0: All 8 action item statuses correctly tracked
- 0.7-0.8: 6-7 correct
- 0.4-0.6: 4-5 correct
- 0.0-0.3: Fewer than 4 correct
"""

    _GAP_RUBRIC = """\
Evaluate identification of missing and overdue items (0.0-1.0).

## Issues that must be identified
1. Missing: Action item 8 (Wang Ming - Wantong POC, due 3/27) has no corresponding to-do -> needs to be created
2. Overdue: TODO-506 (Zhou Ming - Frontend optimization) due 3/24 but still pending -> overdue
3. Approaching deadline: TODO-502, 504, 507 due 3/25 -> need attention

## Strict scoring
- 0.9-1.0: Both missing and overdue items identified with recommendations
- 0.6-0.8: One issue identified
- 0.3-0.5: Noticed issues but not specific enough
- 0.0-0.2: Not identified
"""

    _REPORT_RUBRIC = """\
Evaluate the structure of the report (0.0-1.0).

## A proper report should include
1. Action item list grouped by meeting
2. Status and assignee for each item
3. Overall completion rate (3/8 = 37.5%)
4. Missing and overdue items flagged
5. Focus areas for next week

## Strict scoring
- 0.9-1.0: All 5 elements included
- 0.6-0.8: 3-4 elements
- 0.3-0.5: 1-2 elements
- 0.0-0.2: No structure
"""
