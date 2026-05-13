"""T158_month_end_reconciliation grader — English variant of T192zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T157zh_month_end_reconciliation")


class MonthEndReconciliationGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _ANOMALY_RUBRIC = """\
Evaluate the assistant's ability to identify 3 types of financial anomalies in the month-end reconciliation (0.0-1.0).

## 3 Anomaly Types That Must Be Discovered

Anomaly 1 — Duplicate Charge (Most Severe):
- TXN-1301 and TXN-1302 are identical: same customer CUS-1301, same amount 85000, same date 2026-03-01, same description "March subscription fee"
- CRM shows CUS-1301's expected_monthly=85000, but was charged twice totaling 170000
- Must identify as duplicate charge and recommend refunding 85000

Anomaly 2 — Procurement Amount vs Inventory Intake Mismatch:
- TXN-1305 procurement of ITEM-1303 amount 45000
- ITEM-1303 inventory record: unit_cost=1900 x 20 units intake = 38000
- Discrepancy of 7000 (45000-38000), cause to be investigated

Anomaly 3 — Receivable Shortfall:
- CUS-1303 CRM contract monthly receivable 150000 (contract_amount=150000)
- TXN-1310 actual receipt 120000
- Shortfall of 30000

## Additional Findings (Bonus)
- ITEM-1307 dispatched 5 units but no corresponding sales transaction record
- ITEM-1308 dispatched 3 units but quantity mismatch with transaction record

## Strict scoring
- 0.9-1.0: All 3 anomaly types accurately identified with correct data references
- 0.7-0.8: Found duplicate charge + at least 1 other anomaly
- 0.5-0.6: Only found 2 anomaly types
- 0.3-0.4: Only found 1 anomaly type
- 0.0-0.2: Did not find any anomalies or analysis errors
"""

    _RECONCILIATION_RUBRIC = """\
Evaluate the accuracy of the assistant's root cause analysis and system reconciliation (0.0-1.0).

## Core Root Cause Chain (Most Important)
1. JOB-1301 "Daily Reconciliation" has been failing continuously for 6 days since 3/21
2. Failure reason: reconciliation system API timeout, linked to INT-1303
3. INT-1303 "Reconciliation System" last sync time 2026-03-20, 6 days of data not synced after that
4. Root cause conclusion: reconciliation task interrupted -> financial anomalies not auto-detected -> anomalies accumulated for 6 days unnoticed

## Invoice System Failure Chain
1. JOB-1302 "Auto Invoice Generation" failing since 3/19
2. Failure reason: invoice API version incompatibility (v2 deprecated), linked to INT-1304
3. INT-1304 "Invoice System" status error, vendor upgraded to v3 but our system still calling v2

## Full System Integration Status
- INT-1301/INT-1302 payment gateways normal
- INT-1303 reconciliation system 6 days without sync (urgent)
- INT-1304 invoice system API error (important)

## Customer Receivable Reconciliation Accuracy
- CUS-1301: 85000 expected, 170000 received (duplicate)
- CUS-1302: 45000 expected, 45000-12000 refund received (normal)
- CUS-1303: 150000 expected, 120000 received (shortfall 30000)
- CUS-1304: 30000 expected, 30000-5500 refund received (refund on record)
- CUS-1305: 25000 expected, 25000 received (normal)

## Strict scoring
- 0.9-1.0: Root cause chain (JOB-1301->INT-1303->6-day interruption) complete, customer reconciliation accurate, integration status comprehensive
- 0.7-0.8: Root cause chain basically correct, most reconciliation accurate
- 0.4-0.6: Found task failures but didn't trace to integration fault, or incomplete reconciliation
- 0.0-0.3: No root cause analysis or seriously incorrect analysis
"""

    _ACTION_RUBRIC = """\
Evaluate the quality of action recommendations in the reconciliation report (0.0-1.0).

## A Satisfactory Reconciliation Report Should Include

1. Anomaly summary table: each anomaly type / involved IDs / amounts / impact / urgency level
2. Root cause analysis: reconciliation system failure -> automation interrupted -> anomalies accumulated
3. Specific action recommendations (must include at least these key items):
   a. Immediately handle CUS-1301 duplicate charge, refund 85000
   b. Contact CUS-1303 to confirm 30000 shortfall reason
   c. Urgently fix INT-1303 reconciliation system connection (restore JOB-1301)
   d. Upgrade invoice system SDK to v3 (restore JOB-1302/INT-1304)
   e. Investigate TXN-1305 vs ITEM-1303 discrepancy of 7000
4. Priority ranking: duplicate charge refund (immediate) > reconciliation system restore > invoice system upgrade > shortfall confirmation > procurement discrepancy investigation

## Strict scoring
- 0.9-1.0: All 4 items included, action recommendations are specific and actionable, with priority ranking
- 0.6-0.8: Includes 3 items, recommendations basically feasible
- 0.3-0.5: Includes 1-2 items, or recommendations too vague
- 0.0-0.2: No complete report or no action recommendations
"""
