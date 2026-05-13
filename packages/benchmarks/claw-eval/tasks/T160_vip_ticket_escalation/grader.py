"""T160_vip_ticket_escalation grader — English variant of T194zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T159zh_vip_ticket_escalation")


class VipTicketEscalationGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _ESCALATION_RUBRIC = """\
Evaluate the correctness of the assistant's VIP customer critical ticket escalation process (0.0-1.0).

## Required Identification
- Correctly identify TK-1401 as the most urgent VIP customer ticket (critical priority)
- Check CRM to confirm Wantong Logistics (CUS-1401) is a VIP customer
- Confirm SLA requirements: "1-hour response, 4-hour resolution"
- Read Wantong Logistics complaint email msg_1401 to understand customer demands and urgency

## Required Personnel Assignment
- Incident handler: Ma Qiang (Senior DBA, database expert) — because TK-1401 is a database connection pool issue
- Escalation recipient: Wang Ming (Technical Director) — because P0/P1 incidents require tech director notification
- VIP customer liaison: Zhao Lei (Key Account Manager) — because she is Wantong Logistics' dedicated contact

## Strict scoring
- 0.9-1.0: Correctly identified VIP+critical+SLA, assigned Ma Qiang to handle, notified Wang Ming + Zhao Lei for escalation
- 0.7-0.8: Identified VIP and urgency, found DBA, but missed either Wang Ming or Zhao Lei
- 0.4-0.6: Identified the issue but personnel assignment not precise enough
- 0.2-0.3: Only identified the ticket but did not complete the escalation process
- 0.0-0.1: Did not effectively handle VIP escalation
"""

    _SOLUTION_RUBRIC = """\
Evaluate the accuracy of the assistant's knowledge base solution search (0.0-1.0).

## Required Solution
- Search knowledge base and find KB-1401 "Database Connection Pool Troubleshooting"
- This article directly matches TK-1401 (database connection pool exhaustion)

## Required Key Information Extraction
- Troubleshooting steps: check current connections (SHOW PROCESSLIST) -> kill idle connections -> restart connection pool -> increase max_connections
- Emergency measures: kill connections in Sleep state over 300 seconds, temporarily increase max_connections to 1.5x
- Escalation criteria: VIP customer affected -> escalate to P0, notify DBA and Technical Director

## Strict scoring
- 0.9-1.0: Found KB-1401, accurately extracted troubleshooting steps and emergency measures, linked to VIP escalation criteria
- 0.7-0.8: Found KB-1401, extracted main steps but not detailed enough
- 0.4-0.6: Searched KB but extracted information incomplete
- 0.2-0.3: Searched but did not find the correct article
- 0.0-0.1: Did not search knowledge base
"""

    _COMMUNICATION_RUBRIC = """\
Evaluate the quality of the assistant's escalation notification email drafts (0.0-1.0).

## Required Email Drafts
### Email 1: Customer Reply to Wantong Logistics
Recipient should be Wantong Logistics Director Zhao (zhao@wantong-logistics.com)
Must include:
1. Acknowledge receipt of feedback, apologize for system unavailability
2. Explain that emergency response process has been initiated
3. Explain that a professional DBA (Ma Qiang) has been assigned to handle the database connection pool issue
4. Provide time commitment (SLA: resolve within 4 hours)
5. Sincere and professional tone, demonstrating high regard for VIP customer

### Email 2: Internal Escalation Notification
Recipient should include Technical Director Wang Ming (wangming@company.com) and/or Account Manager Zhao Lei (zhaolei@company.com)
Must include:
1. TK-1401 ticket problem description and severity
2. Wantong Logistics VIP customer information and SLA requirements
3. Confirmation that Ma Qiang (DBA) has been assigned
4. Key steps summary from KB-1401 solution
5. Critical time milestones to watch

## Strict scoring
- 0.9-1.0: Both emails drafted completely, content accurate and professional, contains all key information
- 0.7-0.8: Both emails drafted but one lacks completeness
- 0.5-0.6: Only one email drafted but content is fairly complete
- 0.2-0.4: Email content too brief or templated
- 0.0-0.1: No email drafts created
"""
