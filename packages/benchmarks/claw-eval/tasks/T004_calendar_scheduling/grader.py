"""T02en_calendar_scheduling grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T003zh_calendar_scheduling")


class CalendarSchedulingGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    ATTENDEE_NAMES = ["Mike", "Sarah"]
    TITLE_KEYWORDS = ["project sync", "sync meeting", "Project Sync"]

    _SCHEDULING_ANALYSIS_RUBRIC = """\
Evaluate the agent's scheduling analysis quality and whether the created event \
has an appropriate title.

Part 1 — Scheduling analysis (primary):
1. Showed each attendee's calendar conflicts (when Mike, Sarah, and the user \
are busy)
2. Identified which time slots are free for all participants
3. Explained why the chosen time slot was selected (e.g., "14:30-15:30 works \
for everyone")
4. Referenced specific calendar events as reasons for avoidance

Core test: Did the agent show a complete "check conflicts → find free slots → \
pick best option" analysis flow, rather than just picking a time without explanation?

Part 2 — Event title (secondary):
- The created calendar event title should relate to "project sync"
- Acceptable titles: Project Sync, Project Sync Meeting, Team Sync, etc.
- Title should reflect the "project sync" theme

Scoring:
- 0.9-1.0: Complete scheduling analysis (conflicts, free slots, selection \
rationale), and appropriate event title
- 0.7-0.8: Analysis mostly complete with minor gaps, appropriate title
- 0.5-0.6: Analysis incomplete, or title not quite relevant
- 0.2-0.4: Only briefly mentioned a time, lacking analysis process
- 0.0-0.1: No scheduling analysis at all"""
