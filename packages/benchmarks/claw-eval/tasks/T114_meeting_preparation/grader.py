"""T114_meeting_preparation grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T113zh_meeting_preparation")


class MeetingPreparationGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    _ATTENDEE_RUBRIC = """\
Evaluate the assistant's coverage of attendee information (0.0-1.0).

## Required attendees (6 internal + 1 external)
1. Wang Ming — Technical Director, Product Dept (evt_201 + evt_204 = 2 meetings)
2. Li Hua — Senior Architect, R&D Dept (evt_201 + evt_203 + evt_204 = 3 meetings)
3. Zhao Lei — Account Manager, Sales Dept (evt_201 + evt_202 + evt_204 = 3 meetings)
4. Zhang Wei — Security Manager, Security Dept (evt_202 + evt_204 = 2 meetings)
5. Ma Qiang — Ops Lead, Operations Dept (evt_203 + evt_204 = 2 meetings)
6. Zhou Ming — Frontend Lead, R&D Dept (evt_203 + evt_204 = 2 meetings)
7. Director Chen — External person, no entry in contacts directory

## Strict scoring
- 0.9-1.0: All 7 attendees covered, contact information complete
- 0.7-0.8: At least 5 covered
- 0.4-0.6: 3-4 covered
- 0.0-0.3: Fewer than 3 covered
"""

    _ANALYSIS_RUBRIC = """\
Evaluate the depth of the assistant's analysis (0.0-1.0).

## Key information that must be flagged
1. Director Chen is an external person, not in the internal contacts directory — must be explicitly flagged
2. Li Hua attends 3 meetings (review + tech selection + weekly) — the busiest colleague
3. Zhao Lei also attends 3 meetings (review + demo + weekly) — also very busy
4. Meeting time distribution: 2 in the morning, 2 in the afternoon, with a lunch break

## Strict scoring
- 0.9-1.0: Correctly flags external personnel + identifies busiest colleague + time analysis
- 0.6-0.8: Flags external personnel + identifies busiest colleague
- 0.3-0.5: Only flags external personnel OR only identifies busiest colleague
- 0.0-0.2: No analysis performed
"""

    _MATERIAL_RUBRIC = """\
Evaluate the structure and completeness of meeting preparation materials (0.0-1.0).

## Acceptable materials should include
1. Clear structure grouped by meeting
2. For each meeting: time, location, agenda, attendee list (with job title and contact info)
3. De-duplicated attendee summary table (complete list after removing duplicates)
4. Special reminders (external personnel, transitions between meetings, etc.)

## Strict scoring
- 0.9-1.0: All 4 items included, professionally formatted
- 0.6-0.8: 3 items included
- 0.3-0.5: 1-2 items included
- 0.0-0.2: No structured materials produced
"""
