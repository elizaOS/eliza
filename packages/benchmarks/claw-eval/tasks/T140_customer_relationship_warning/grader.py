"""T140_customer_relationship_warning grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T139zh_customer_relationship_warning")


class CustomerRelationshipWarningGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    _RISK_RUBRIC = """\
Evaluate whether the assistant correctly identified all at-risk customers (0.0-1.0).

## Customers that must be identified (today is 2026-03-26, within 60 days)
1. CUS-903 Wantong Logistics (VIP, expires April 5, only 10 days) — most urgent
2. CUS-901 Dingxin Software (VIP, expires April 15, 20 days)
3. CUS-906 Qianfeng Technology (standard, expires April 30, 35 days)
4. CUS-902 Hanhai E-commerce (standard, expires May 20, 55 days)

## Should not be included
- CUS-904 Public Institution (expires August 1, 127 days)
- CUS-905 Sunshine Media (expires December 31, 280 days)

## Must cross-validate
- Reviewed CRM customer details (tier, revenue, sales rep)
- Checked emails for recent communications (msg_901 Wantong renewal inquiry, msg_902 Dingxin upgrade interest)

## Strict scoring
- 0.9-1.0: All 4 customers correctly identified, excluded the 2 out-of-scope ones, referenced email leads
- 0.7-0.8: All 4 customers identified correctly but missing email cross-validation
- 0.5-0.6: Identified 3 customers
- 0.3-0.4: Only identified 1-2
- 0.0-0.2: Identification not effectively completed
"""

    _PRIORITY_RUBRIC = """\
Evaluate the assistant's priority ranking and depth of analysis (0.0-1.0).

## Correct priority ranking
1. CUS-903 Wantong Logistics ★ Most urgent
   Reason: VIP customer + only 10 days left + customer proactively emailed about renewal (msg_901)
2. CUS-901 Dingxin Software
   Reason: VIP customer + 20 days left + has upgrade interest (msg_902)
3. CUS-906 Qianfeng Technology
   Reason: standard customer + 35 days left + no recent communication
4. CUS-902 Hanhai E-commerce
   Reason: standard customer + 55 days left + no recent communication

## Analysis must include
- VIP customers (903, 901) should be prioritized
- Urgency of Wantong Logistics (10 days + inquiry sent but no reply -> immediate action needed)
- Sales representative and contact information for each customer
- Differentiated renewal strategies (VIP vs standard)

## Strict scoring
- 0.9-1.0: Ranking fully correct + thorough reasoning + differentiated strategies
- 0.7-0.8: Ranking mostly correct but reasoning not detailed enough
- 0.5-0.6: VIP priority basically correct but details lacking
- 0.3-0.4: Obvious errors in ranking
- 0.0-0.2: No effective ranking provided
"""

    _DRAFT_RUBRIC = """\
Evaluate the quality of the renewal email draft for VIP customers (0.0-1.0).

## Must draft a reply for Wantong Logistics (CUS-903)
The email should include:
1. Respond to the customer's renewal inquiry (addressing msg_901)
2. Express gratitude for the long-term partnership (a major client with 1.2M annual revenue)
3. Show commitment and arrange a dedicated follow-up
4. Provide a specific timeline for communication (e.g., schedule an in-person meeting or call this week)
5. Professional and sincere tone, reflecting VIP service standards

## Bonus points
- Also drafted an email for Dingxin Software (CUS-901)
- Email mentions the customer's upgrade requirements

## Strict scoring
- 0.9-1.0: Includes all 5 elements, professional wording, tailored content
- 0.7-0.8: Includes 4 elements, appropriate tone
- 0.5-0.6: Includes 3 elements, but overly templated
- 0.2-0.4: Too brief
- 0.0-0.1: No email draft created
"""
