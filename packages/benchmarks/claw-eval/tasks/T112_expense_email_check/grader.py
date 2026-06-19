"""T112_expense_email_check grader — English variant of T146zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T111zh_expense_email_check")


class ExpenseEmailCheckGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _MATCHING_RUBRIC = """\
Evaluate the accuracy of the assistant's matching of reimbursement emails to finance records (0.0-1.0).

## Correct Matching Results (4 reimbursements)
1. msg_701 (Zhang Wei travel expenses 3200 CNY, INV-001) <-> TXN-701 (3200 CNY, completed) -> Full match
2. msg_702 (Li Hua office supplies 850 CNY, INV-002) <-> TXN-702 (680 CNY, completed) -> Amount mismatch (difference of 170 CNY)
3. msg_703 (Wang Ming training fee 5000 CNY, INV-003) <-> TXN-703 (5000 CNY, pending) -> Amount matches but not completed
4. msg_704 (Chen Jing meal expenses 420 CNY, INV-004) <-> TXN-704 (420 CNY, completed) -> Full match

## Distractor Handling
- msg_705 (administrative notice) should be excluded; it is not a reimbursement email
- TXN-705 (utilities) and TXN-706 (employee payroll) should not be mixed into reimbursement verification

## Strict Scoring
- 0.9-1.0: All 4 reimbursements correctly matched, distractors properly excluded
- 0.7-0.8: At least 3 correctly matched
- 0.4-0.6: 2 correctly matched
- 0.0-0.3: Matching errors or verification not completed
"""

    _DISCREPANCY_RUBRIC = """\
Evaluate the depth of the assistant's analysis of anomalies (0.0-1.0).

## Must-Discover Anomalies
Anomaly 1 — Amount mismatch (msg_702 vs TXN-702):
- Email claims reimbursement of 850 CNY, finance record shows only 680 CNY, difference of 170 CNY
- Should analyze possible reasons (some items not recorded? Invoice amount differs from actual purchase?)
- Should recommend: Contact Li Hua to confirm details, verify original invoice

Anomaly 2 — Status anomaly (msg_703 vs TXN-703):
- Amount of 5000 CNY matches, but TXN-703 status is pending (not completed)
- Should note: Reimbursement approved but payment has not yet reached the applicant's account
- Should recommend: Follow up on finance process, confirm expected payment date

## Strict Scoring
- 0.9-1.0: Both anomalies accurately identified, reasonable cause analysis, specific recommendations
- 0.6-0.8: Both anomalies identified but analysis lacks depth
- 0.3-0.5: Only 1 anomaly identified
- 0.0-0.2: No anomalies discovered or analysis is incorrect
"""

    _REPORT_RUBRIC = """\
Evaluate the structure and quality of the verification report (0.0-1.0).

## An Acceptable Report Should Include
1. A categorized list by status (normal / amount anomaly / status anomaly)
2. Comparison details for each reimbursement (email amount vs finance amount)
3. Specific explanations and recommended actions for anomalous items
4. Explanation of how non-reimbursement emails were handled (excluded)
5. Clear formatting, ready for direct use by finance staff

## Strict Scoring
- 0.9-1.0: All 5 elements included, professional and clear formatting
- 0.6-0.8: 3-4 elements included, generally clear formatting
- 0.3-0.5: Incomplete content or messy formatting
- 0.0-0.2: No complete report produced
"""
