"""T108_ticket_routing grader — English variant of T142zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T107zh_ticket_routing")


class TicketRoutingGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only.

    All scoring logic (tool gates, LLM judge calls, weighting) is inherited
    from the ZH base grader unchanged.
    """

    _ROUTING_RUBRIC = """\
Evaluate whether the assistant correctly applied all priority rules (0.0-1.0).

## Rules that must be applied (from KB-205 SLA standards)
Rule A — VIP customer tickets are automatically escalated one priority level
Rule B — Customers within 60 days of contract expiration have ticket priority automatically escalated one level

## Correct routing results for 5 tickets

1. TK-504 (Wantong Logistics CUS-504 / VIP / original priority=critical)
   -> Rule A applies -> Escalate to P0
   -> Must notify risk control team (KB-204 mentions "financial data involved -> notify risk control")
   * This is the highest priority ticket

2. TK-501 (Dingxin Software CUS-501 / VIP / original priority=high)
   -> Rule A applies -> Escalate to critical/P1
   -> CRM record requires 4-hour response

3. TK-502 (Hanhai E-commerce CUS-502 / renewal period - expires April / original priority=medium)
   -> Rule B applies -> Escalate to high
   -> Must sync-notify sales team

4. TK-505 (Hanhai E-commerce CUS-502 / renewal period / original priority=low)
   -> Rule B applies -> Escalate to medium

5. TK-503 (Public institution CUS-503 / standard / original priority=low)
   -> No rules apply -> Remains low/P3

## Strict scoring
- 0.9-1.0: All 5 tickets routed correctly, rule application rationale is clear
- 0.7-0.8: 4 correct (1 miss allowed, but VIP tickets TK-504 and TK-501 must be correct)
- 0.5-0.6: 3 correct
- 0.3-0.4: VIP rule correct but renewal-period rule missed
- 0.0-0.2: VIP rule also not correctly applied
"""

    _KB_MATCHING_RUBRIC = """\
Evaluate the accuracy of the assistant's knowledge base solution matching for each ticket (0.0-1.0).

Correct matches (must match to the right KB article and provide targeted recommendations):
1. TK-504 data sync delay -> KB-204 (Data sync fault troubleshooting) -> Recommendation: check Kafka consumer, restart worker
2. TK-501 API timeout -> KB-201 (API performance optimization guide) -> Recommendation: check slow queries, increase timeout threshold
3. TK-502 export error 500 -> KB-202 (Data export fault troubleshooting) -> Recommendation: reduce scope, export in batches
4. TK-503 batch permission modification -> KB-203 (Batch management operations manual) -> Provide specific operation steps
5. TK-505 chart display issue -> No direct KB match (should state this honestly)

## Strict scoring
- 0.9-1.0: 4 correct matches + identified TK-505 has no direct KB match
- 0.7-0.8: At least 3 of the 4 matches correct
- 0.4-0.6: 2 correct
- 0.0-0.3: Matches wrong or knowledge base not searched
"""

    _COMPLETENESS_RUBRIC = """\
Evaluate the completeness of the final routing report (0.0-1.0).

A qualifying report must cover all 5 tickets one by one, each including:
- Adjusted priority and the applicable rule
- Recommended KB solution (or note that no match exists)
- Escalation/special handling flags
- Internal teams that need to be notified

## Strict scoring
- 0.9-1.0: All 5 tickets covered, each with complete 4-item content
- 0.7-0.8: All 5 tickets covered, some missing individual details
- 0.5-0.6: Only 3-4 tickets covered
- 0.3-0.4: Only 1-2 tickets covered
- 0.0-0.2: No complete report produced
"""
