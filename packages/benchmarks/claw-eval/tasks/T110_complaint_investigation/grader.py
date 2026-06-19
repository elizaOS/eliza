"""T110_complaint_investigation grader — English variant of T144zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T109zh_complaint_investigation")


class ComplaintInvestigationGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only.

    All scoring logic (tool gates, LLM judge calls, weighting) is inherited
    from the ZH base grader unchanged.
    """

    _CASE1_RUBRIC = """\
Evaluate the depth of the assistant's investigation of Case 1 (Zhonghe Group CUS-601 bill doubled) (0.0-1.0).

## Facts that must be discovered
- Contract stipulates monthly fee of 120,000 CNY (CRM: annual revenue 1,440,000 = 120K/month)
- January 2026 bill was normal: TXN-601 = 120,000
- February 2026 bill doubled: TXN-602 = 240,000, description "including add-on modules"
- March 2026 same: TXN-603 = 240,000, description "including add-on modules"
- The extra 120,000/month is for "add-on module" charges

## Analysis that must be provided
- Judgment: add-on modules may have been added without customer confirmation, or it is a billing system error
- This is a VIP customer (tier=vip), should be handled with priority
- Recommendation: contact Finance Dept to verify billing, contact Sales Dept to confirm add-on authorization records

## Strict scoring
- 0.9-1.0: Discovered amount change + identified "add-on module" reason + VIP priority + specific handling recommendations
- 0.6-0.8: Discovered the billing issue, gave rough direction, but lacking precise data support
- 0.3-0.5: Only mentioned the customer complaint, did not dig into finance records
- 0.0-0.2: Did not effectively investigate this case
"""

    _CASE2_RUBRIC = """\
Evaluate the depth of the assistant's investigation of Case 2 (Qianfeng Tech CUS-602 refund not received) (0.0-1.0).

## Facts that must be discovered
- Customer claims service outage on March 1-3, loss of about 50,000 CNY, support promised compensation but not received
- CRM record: CUS-602 notes mention "compensation promised but not executed"
- Finance record: TXN-604 = -50,000 CNY (negative = refund), type "service outage compensation"
- Key finding: TXN-604 status is "pending" (approved, awaiting execution), approved by Liu Yang

## Analysis that must be provided
- Refund is approved but stuck at the execution stage, not that it wasn't approved
- Recommendation: contact Finance Dept Liu Yang to expedite refund execution, give customer a clear timeline commitment

## Strict scoring
- 0.9-1.0: Found TXN-604 + identified pending status + knows approver is Liu Yang + gave follow-up recommendation
- 0.6-0.8: Found refund record, knows it's unexecuted, but missing specific details
- 0.3-0.5: Mentioned the refund issue but didn't verify with finance system
- 0.0-0.2: Did not effectively investigate this case
"""

    _CASE3_RUBRIC = """\
Evaluate the depth of the assistant's investigation of Case 3 (Sunlight Media CUS-603 feature downgrade) (0.0-1.0).

## Facts that must be discovered
- Customer claims features were downgraded on March 15, didn't discover until March 20, received no notification
- CRM record: CUS-603 notes say "premium features automatically downgraded due to payment delay, payment made on March 18"
- Finance record: TXN-606 = March 18 payment of 40,000 CNY

## Analysis that must be provided
- Downgrade reason: payment delay triggered automatic downgrade mechanism
- Problem: features still not restored after March 18 payment (customer still complaining on March 25)
- System notification defect: customer was not notified during downgrade
- Recommendation: contact Tech Dept to restore features + improve automatic notification mechanism

## Strict scoring
- 0.9-1.0: Fully reconstructed event chain (delay -> downgrade -> payment -> not restored) + dual recommendation (restore + fix notifications)
- 0.6-0.8: Found the cause and payment record, but missing notification improvement recommendation
- 0.3-0.5: Only mentioned downgrade without investigating the cause
- 0.0-0.2: Did not effectively investigate this case
"""

    _DRAFT_RUBRIC = """\
Evaluate the quality of the reply email drafted for Zhonghe Group (VIP customer) (0.0-1.0).

## Passing requirements
The email must include:
1. Acknowledgment of the billing anomaly and apology
2. Explanation that an internal investigation is underway (discovered "add-on module" charge anomaly)
3. Clear time commitment (e.g., verification results within 24/48 hours)
4. If overcharging is confirmed, commitment to refund the difference
5. Professional and sincere tone, reflecting VIP customer importance

## Strict scoring
- 0.9-1.0: All 5 items included, professional and appropriate wording
- 0.7-0.8: 4 items included, appropriate tone
- 0.5-0.6: 3 items included, but missing time commitment or refund commitment
- 0.2-0.4: Too brief or formulaic
- 0.0-0.1: No email draft saved
"""
