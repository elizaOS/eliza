"""T116_ticket_kb_suggestion grader — English variant of T150zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T115zh_ticket_kb_suggestion")


class TicketKBSuggestionGrader(_Base):  # type: ignore[misc]
    """English grader for T151: match helpdesk tickets with KB articles.

    Inherits scoring logic from T150zh and overrides only Chinese rubric strings.
    """

    _KB_MATCHING_RUBRIC = """\
Evaluate the accuracy of the assistant's ticket-to-KB-article matching (0.0-1.0).

## Correct matches
1. TK-601 (API 500 error) -> KB-601 (API Error Code Troubleshooting Guide)
   Suggestion: check logs, connection pool, dependent services
2. TK-602 (bulk export timeout) -> KB-602 (Data Export Operations Manual)
   Suggestion: use the API async export method
3. TK-603 (login page loads slowly) -> KB-603 (System Performance Optimization Tips)
   Note: article is outdated, must be flagged
4. TK-604 (printer cannot connect) -> No match
   Flag: requires manual handling, no relevant KB article
5. TK-605 (permissions not taking effect) -> KB-604 (Permission Management Best Practices)
   Suggestion: user should re-login and wait for cache refresh

## Strict scoring
- 0.9-1.0: All 5 tickets handled correctly (4 matched + 1 unmatched)
- 0.7-0.8: 4 correct
- 0.4-0.6: 3 correct
- 0.0-0.3: Fewer than 3 matched or major errors
"""

    _STALENESS_RUBRIC = """\
Evaluate the assistant's identification of KB staleness and unmatched tickets (0.0-1.0).

## Issues that must be identified
1. KB-603 (System Performance Optimization Tips) last_updated = 2025-06-01
   - Over 9 months old; the article itself notes "some information may be outdated"
   - Should recommend: refer to KB-603 but verify against current situation; suggest updating the article

2. TK-604 (printer cannot connect)
   - No hardware-related articles in the knowledge base
   - Should recommend: escalate to IT operations or admin department for manual handling

## Strict scoring
- 0.9-1.0: Both issues accurately identified and addressed
- 0.5-0.7: One issue identified
- 0.0-0.4: Neither identified
"""

    _SUGGESTION_RUBRIC = """\
Evaluate the quality and actionability of suggested replies (0.0-1.0).

## A good suggestion reply should include
1. Specific resolution steps for each ticket (not generic advice)
2. References to specific sections of KB articles
3. Priority annotations (TK-601 and TK-603 are high priority)
4. Alternative approaches for unmatched tickets
5. Usage caveats for outdated articles

## Strict scoring
- 0.9-1.0: All 5 elements included
- 0.6-0.8: 3-4 elements included
- 0.3-0.5: 1-2 elements included
- 0.0-0.2: Suggestions too vague or missing
"""
