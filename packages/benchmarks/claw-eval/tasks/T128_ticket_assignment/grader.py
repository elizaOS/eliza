"""T128_ticket_assignment grader — English variant of T162zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T127zh_ticket_assignment")


class TicketAssignmentGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _ROUTING_RUBRIC = """\
Evaluate the accuracy of the assistant's ticket assignments (0.0-1.0).

## Correct Assignment Plan
1. TK-901 System login failure -> Ma Qiang / IT Ops Team (system failure)
2. TK-902 Inaccurate report data -> Li Hua / Data Team (data quality issue)
3. TK-903 VPN connection failure -> Ma Qiang / IT Ops Team (network infrastructure)
4. TK-904 Permission request -> Zhang Wei / Security Team (account permission management)
5. TK-905 Broken office chair -> Chen Ting / Admin Dept (office equipment, non-IT)
6. TK-906 Email storage full -> Ma Qiang / IT Ops Team (email system management)

## Strict Scoring
- 0.9-1.0: All 6 correct, especially distinguishing TK-905 (Admin) and TK-904 (Security)
- 0.7-0.8: 5 correct
- 0.4-0.6: 3-4 correct
- 0.0-0.3: Fewer than 3 correct
"""

    _REASONING_RUBRIC = """\
Evaluate the quality and logic of assignment reasoning (0.0-1.0).

## Good Assignment Reasoning Should Include
1. Issue type classification (system failure / data issue / network / permission / admin)
2. Explanation of the handler's responsibilities (why this person)
3. Explicitly noting TK-905 is a non-IT issue (office equipment belongs to admin)
4. When Ma Qiang handles 3 tickets, suggest priority-based processing order

## Strict Scoring
- 0.9-1.0: Each assignment has clear reasoning, IT/non-IT distinction is explicit
- 0.6-0.8: Most have reasoning, some not clear enough
- 0.3-0.5: Reasoning is vague
- 0.0-0.2: No reasoning or incorrect reasoning
"""

    _FORMAT_RUBRIC = """\
Evaluate the format and completeness of the assignment suggestion table (0.0-1.0).

## Acceptable Output Should Include
1. Clear table or list (ticket -> handler -> reason)
2. Key information for each ticket (title, priority, type)
3. Handler's contact information
4. Handling suggestions or notes

## Strict Scoring
- 0.9-1.0: All 4 elements included, professional format
- 0.6-0.8: 3 elements included
- 0.3-0.5: 1-2 elements
- 0.0-0.2: Disorganized format
"""
