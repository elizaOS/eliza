"""T130_business_trip_planning grader — English variant of T164zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T129zh_business_trip_planning")


class BusinessTripPlanningGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _CONFLICT_RUBRIC = """\
Evaluate the assistant's analysis of business trip schedule conflicts (0.0-1.0).

## Must-Identify Conflict
April 2 three-way conflict:
- Shanghai: VIP client Dingxin Software invitation to visit (msg_801) — important client
- Shenzhen: Tech exchange 4/2-4/3 (msg_802) — non-essential
- Local: Product review meeting 9:00-12:00 (evt_401) — can be rescheduled

April 5 no conflict:
- Beijing annual meeting (msg_803 + evt_403) — confirmed + flight booked

## Strict Scoring
- 0.9-1.0: Correctly identified 4/2 three-way conflict + 4/5 no conflict, excluded distractor emails
- 0.7-0.8: Identified 4/2 conflict but analysis not detailed enough
- 0.4-0.6: Identified partial conflicts
- 0.0-0.3: Conflict analysis incorrect
"""

    _RECOMMENDATION_RUBRIC = """\
Evaluate the reasonableness of the trip recommendation (0.0-1.0).

## Reasonable Plan
1. Prioritize Shanghai for 4/2 (VIP client > tech exchange > local review)
2. Local product review needs to be rescheduled
3. Shenzhen can be declined or see if 4/3 solo visit is possible
4. Attend Beijing on 4/5 as planned
5. Possible itinerary optimization: 4/2 Shanghai -> 4/3 Shenzhen -> 4/4 Beijing -> 4/5 Beijing meeting

## Strict Scoring
- 0.9-1.0: Plan is reasonable with optimization suggestions, considers itinerary connections
- 0.6-0.8: General direction correct but lacks optimization
- 0.3-0.5: Has suggestions but not reasonable enough
- 0.0-0.2: No suggestions or infeasible suggestions
"""

    _CONTACT_RUBRIC = """\
Evaluate the completeness of contact preparation (0.0-1.0).

## Contacts That Should Be Listed
- Shanghai: Manager Chen (client relations), Director Wu (office head)
- Shenzhen: Li Wei (technical manager), Engineer Huang (senior engineer)
- Beijing: VP Zhang (vice president), Secretary Liu (meeting organizer)

## Strict Scoring
- 0.9-1.0: Contacts for all three cities complete, with contact details
- 0.6-0.8: At least two cities' contacts complete
- 0.3-0.5: Only partial contacts listed
- 0.0-0.2: Contacts not looked up
"""
