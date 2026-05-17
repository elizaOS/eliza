"""T15en_cross_service_meeting grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T029zh_cross_service_meeting")


class CrossServiceMeetingGraderEN(_Base):
    """English variant — overrides language-specific class attributes only."""

    PARTICIPANTS = {
        "Leo Zhao": "leozhao@company.com",
        "Mike Li": "mikeli@company.com",
        "Director Chen": "director@partner-corp.com",
    }

    CONTACT_SEARCH_NAMES = {
        "Leo Zhao": ["leo", "zhao", "leozhao"],
        "Mike Li": ["mike", "li", "mikeli"],
    }

    CALENDAR_USER_NAMES = {
        "Leo Zhao": "leozhao",
        "Mike Li": "mikeli",
    }

    TITLE_KEYWORDS = ["review", "project", "Partner", "Review"]

    _REPLY_QUALITY_RUBRIC = """\
Evaluate the agent's reply email to Director Chen (director@partner-corp.com) \
confirming the project review meeting. Correct time: March 4, 2026 (Wed) \
15:00-17:00, with Leo Zhao, Mike Li, and Director Chen's team.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: Information Completeness (weight 40%) ===
The reply should include all key meeting details:
- Confirmed date and time (March 4, 15:00-17:00)
- Meeting duration (2 hours)
- Attendees (Leo Zhao, Mike Li, Director Chen's team)
- Meeting topic (project review)

Part 1 scoring:
- 0.9-1.0: All information complete and accurate
- 0.7-0.8: Time confirmed but missing 1-2 items
- 0.4-0.6: Time correct but most details missing
- 0.0-0.3: Key info (time/date) wrong or missing

=== Part 2: Reasoning Transparency (weight 30%) ===
Did the reply explain the time selection reasoning:
- Mentioned Leo is busy 14:00-15:00 so 15:00 was chosen
- Noted all participants are free during 15:00-17:00
- Offered alternative (Thursday) in case Director Chen is unavailable

Part 2 scoring:
- 0.9-1.0: Clearly explained the time selection reasoning
- 0.6-0.8: Stated time with brief reasoning
- 0.3-0.5: Mentioned time but no reasoning
- 0.0-0.2: No reasoning at all

=== Part 3: Professionalism (weight 30%) ===
Is the reply appropriate for external communication:
- Polite and professional tone (addressing partner company director)
- Clear structure and formatting
- Appropriate subject line

Part 3 scoring:
- 0.9-1.0: Professional, well-written, polished
- 0.6-0.8: Generally professional but somewhat casual
- 0.3-0.5: Information conveyed but insufficiently formal
- 0.0-0.2: Unprofessional or poorly written

Output the final weighted score: score = 0.40×Part1 + 0.30×Part2 + 0.30×Part3"""
