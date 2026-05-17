"""T156_onsite_support_dispatch grader — English variant of T190zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T155zh_onsite_support_dispatch")


class OnsiteSupportDispatchGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _DISPATCH_RUBRIC = """\
Evaluate whether the assistant's dispatch decision logic is correct (0.0-1.0).

## Correct Dispatch Decision

### Step 1: Identify the Urgent Ticket
- TK-1201 (Wantong Logistics / VIP / critical) is the only ticket requiring urgent onsite support
- Other tickets (TK-1202 medium, TK-1203 low, TK-1204 medium) do not need urgent onsite response
- Email msg_1201 confirms the customer is pressing, requiring arrival before 2:00 PM

### Step 2: Engineer Selection
- Ma Qiang (PRIMARY / best choice):
  - Skills perfectly match: system troubleshooting + database operations + network diagnostics
  - Free from 13:00 onwards (9:00-12:00 meetings but no afternoon commitments)
  - Located at Shanghai HQ, can travel to Pudong customer site
  - 10 years ops experience, holds OCP and RHCE certifications

- Li Hua (BACKUP):
  - Mostly free all day (only morning architecture review meeting)
  - But skills lean toward architecture design / performance optimization, not the best fit for system outage recovery
  - Can serve as backup or remote support

- Zhou Ming (UNAVAILABLE):
  - All day in Shenzhen on business (evt_1203: 9:00-17:00 Shenzhen customer site)
  - Physically cannot reach Shanghai Pudong
  - Skills are frontend development, not matching system outage scenario

### Step 3: Dispatch Plan
- Dispatch Ma Qiang to Wantong Logistics site in Shanghai Pudong
- Consider SLA: ticket created at 10:15, 4-hour SLA deadline is 14:15, Ma Qiang can depart after 1 PM
- Li Hua as remote backup or follow-up support

## Strict scoring
- 0.9-1.0: Correctly selected Ma Qiang as primary, complete comparison analysis of all 3 engineers' skills/schedules, clear recommendation rationale
- 0.7-0.8: Selected Ma Qiang but analysis not thorough (e.g., didn't compare all 3 or didn't mention Li Hua as backup)
- 0.4-0.6: Selected a reasonable candidate but insufficient reasoning, or selected Li Hua as primary
- 0.2-0.3: Incorrectly selected Zhou Ming or did not perform selection analysis
- 0.0-0.1: Did not complete dispatch decision
"""

    _CONSTRAINT_RUBRIC = """\
Evaluate the assistant's satisfaction of constraint conditions (0.0-1.0).

## Constraints That Must Be Identified and Satisfied

### 1. VIP Customer SLA Constraint (Most Critical)
- CUS-1201 is a VIP customer (tier=vip), SLA level: platinum
- SLA requirement: critical tickets require 4-hour onsite response
- Ticket created at 10:15, SLA deadline is 14:15
- Customer email demands arrival by 2:00 PM — consistent with SLA
- Must explicitly mention the 4-hour SLA time constraint

### 2. Skill Matching Constraint
- Production system outage (database connection pool exhausted / primary node failure) requires:
  - System troubleshooting capability -> Ma Qiang matches
  - Database operations capability -> Ma Qiang matches
- Does NOT require: frontend development (Zhou Ming), architecture design (Li Hua, though somewhat helpful)

### 3. Schedule Availability Constraint
- Ma Qiang: morning meeting (9:00-12:00), afternoon free -> can be dispatched
- Li Hua: morning review meeting (10:30-12:00), otherwise free -> can serve as backup
- Zhou Ming: all day Shenzhen business trip (9:00-17:00) -> unavailable
- Must explicitly identify Zhou Ming as unavailable (in Shenzhen, not Shanghai)

### 4. Geographic Location Constraint
- Customer is in Shanghai Pudong
- Ma Qiang and Li Hua are at Shanghai HQ, can reach the site
- Zhou Ming is in Shenzhen, cannot reach the site

### 5. Escalation Notification Constraint
- VIP customer critical ticket requires notifying Technical Director Wang Ming (escalation contact)
- Must notify Account Manager Zhao Lei (Wantong Logistics point of contact)

## Strict scoring
- 0.9-1.0: All 5 constraints identified and reflected in analysis
- 0.7-0.8: At least identified SLA time constraint + Zhou Ming unavailable + skill matching (3 core constraints)
- 0.5-0.6: Identified SLA and skill matching but missed Zhou Ming unavailability or notification targets
- 0.3-0.4: Only identified 1-2 constraints
- 0.0-0.2: Severely insufficient constraint analysis
"""

    _NOTIFICATION_RUBRIC = """\
Evaluate the quality of the assistant's notification email drafts (0.0-1.0).

## Minimum Requirement — At Least 1 Dispatch Notification Draft

### Email Draft Should Include
1. Correct recipients:
   - Primary notification: Ma Qiang (dispatched engineer)
   - CC/separate email: Zhao Lei (account manager) and/or Wang Ming (technical director / escalation)
2. Customer information: Wantong Logistics, VIP customer, Shanghai Pudong
3. Problem description: Production system outage, database connection pool exhausted
4. SLA requirement: 4-hour onsite response, deadline 14:15 (or before 2 PM)
5. Dispatch arrangement: Expected arrival time
6. Professional and urgent tone, reflecting importance of VIP customer

### Bonus Points
- Also drafted notification to account manager
- Included backup plan (if Ma Qiang cannot arrive on time, Li Hua as substitute)
- Mentioned tools/materials to prepare

## Strict scoring
- 0.9-1.0: Draft contains all 6 required items, notification targets complete (Ma Qiang + Zhao Lei + Wang Ming)
- 0.7-0.8: Draft contains at least 4 required items, at least notified Ma Qiang and Zhao Lei
- 0.5-0.6: Has draft but information incomplete, or missing key notification targets
- 0.2-0.4: Draft too brief or notification targets incorrect
- 0.0-0.1: Did not draft any email
"""
