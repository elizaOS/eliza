"""T142_sla_compliance_audit grader — English variant of T176zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T141zh_sla_compliance_audit")


class SlaComplianceAuditGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _COMPLIANCE_RUBRIC = """\
Evaluate the accuracy of the assistant's SLA compliant/non-compliant judgments (0.0-1.0).

## SLA Standards (from INT-901 configuration)
- critical: respond within 60 minutes
- high: respond within 240 minutes (4 hours)
- medium: respond within 480 minutes (8 hours)
- low: respond within 1440 minutes (24 hours)

## Correct Judgments
1. TK-701 critical: created 08:00, responded 08:35 = 35 min -> Compliant
2. TK-702 high: created 3/24 10:00, responded 3/24 16:30 = 390 min (6.5 hours) -> Non-compliant (exceeded by 2.5 hours)
3. TK-703 medium: created 3/24 14:00, responded 3/24 20:00 = 360 min (6 hours) -> Compliant
4. TK-704 medium: created 3/25 09:00, responded 3/25 16:55 = 475 min (7 hours 55 min) -> Borderline compliant (only 5 min margin)
5. TK-705 low: created 3/23 11:00, responded 3/24 09:00 = 1320 min (22 hours) -> Compliant
6. TK-706: Internal ticket, SLA not applicable

## Strict scoring
- 0.9-1.0: All 6 tickets correctly judged, precise calculations, identified TK-704's borderline status
- 0.7-0.8: Correctly identified TK-702 as non-compliant, others roughly correct
- 0.5-0.6: Knows there are non-compliant tickets but calculations imprecise
- 0.3-0.4: Missed the key non-compliant ticket
- 0.0-0.2: SLA calculations clearly wrong
"""

    _ROOT_CAUSE_RUBRIC = """\
Evaluate the depth of the assistant's root cause analysis of automation failures (0.0-1.0).

## Causal chain that must be discovered
1. JOB-902 (SLA timeout alert) has been failing since 2026-03-24 08:00
2. Error message: "Email service connection failed: SMTP timeout"
3. Has failed 8 consecutive times
4. Root cause: INT-902 (email notification integration) OAuth token expired
5. Impact: TK-702 was created at 3/24 10:00 and should have received an alert before timeout, but JOB-902's failure prevented the alert
6. JOB-901 (auto-assignment) and JOB-903 (daily report) are running normally, unaffected

## Strict scoring
- 0.9-1.0: Complete causal chain (JOB-902->INT-902->TK-702 impact) + quantitative analysis (failed 8 times/since 3/24)
- 0.7-0.8: Discovered JOB-902 failure and INT-902 expiry correlation, but missing impact analysis on TK-702
- 0.5-0.6: Discovered JOB-902 failure but didn't trace to INT-902
- 0.3-0.4: Only mentioned task failures
- 0.0-0.2: Did not check automation task status
"""

    _RECOMMENDATION_RUBRIC = """\
Evaluate the quality and actionability of improvement recommendations (0.0-1.0).

## Required recommendations
1. Urgent: Fix INT-902's OAuth authorization (specific steps)
2. Short-term: Use INT-903 (instant messaging webhook) as a backup notification channel
3. TK-704 is in borderline status (5 min from non-compliance), need to monitor response efficiency
4. Establish multi-channel alerting mechanism to avoid single point of failure
5. TK-702 needs immediate escalation (already exceeded SLA)

## Strict scoring
- 0.9-1.0: All 5 recommendations included, actionable
- 0.7-0.8: Contains 4 items, logically clear
- 0.5-0.6: Contains 2-3 key recommendations
- 0.3-0.4: Recommendations too generic
- 0.0-0.2: No effective recommendations given
"""
