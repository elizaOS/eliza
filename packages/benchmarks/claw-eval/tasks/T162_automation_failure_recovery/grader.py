"""T162_automation_failure_recovery grader — English variant of T196zh."""
from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T161zh_automation_failure_recovery")


class AutomationFailureRecoveryGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _CASCADE_RUBRIC = """\
Evaluate the completeness of the assistant's analysis of the automation task \
dependency chain failure (0.0-1.0).

## Required Dependency Chain
JOB-1501 (Supplier Data Sync) -> JOB-1502 (Inventory Auto Update) -> \
JOB-1503 (Auto Restock Trigger)

### Failure Details for Each Stage
1. JOB-1501 (root node):
   - Calling https://supplier-api.example.com/v2/data returns 404
   - Continuously failing since 2026-03-20 (last success was March 20 at 08:00)
   - No dependencies; this is the starting point of the entire chain

2. JOB-1502 (second stage):
   - Depends on JOB-1501 (depends_on: ["JOB-1501"])
   - Error message explicitly states "upstream data source unavailable, \
JOB-1501 most recent execution failed"
   - Cannot obtain supplier data because JOB-1501 is continuously failing

3. JOB-1503 (third stage):
   - Depends on JOB-1502 (depends_on: ["JOB-1502"])
   - Error message: "inventory data stale, last sync was 2026-03-20, \
exceeds 24-hour threshold"
   - Refuses to execute auto-restock because inventory data has not been \
updated for 6 days

### Inventory Impact
- ITEM-1501/1502/1503: three products with last_sync stuck at March 20 \
(6 days ago)
- ITEM-1503 (network switch): quantity 3, below safety level of 5, but \
restock not triggered
- ITEM-1502 (USB-C docking station): shows 0 but supplier may have \
already restocked

### Ticket Correlation
- TK-1501 (inventory discrepancy) <- JOB-1502 failure causing data desync
- TK-1502 (restock not triggered) <- JOB-1503 failure stopping auto-restock
- TK-1503 (prices not updated) <- JOB-1501 failure stopping supplier data sync
- TK-1504 (printer malfunction) <- unrelated, hardware issue

## Strict Scoring
- 0.9-1.0: Fully identified three-level dependency chain + error cause at \
each stage + inventory impact + 3 tickets correctly correlated + excluded TK-1504
- 0.7-0.8: Identified the dependency chain and most impacts, but missing \
some details (e.g., specific affected products or incomplete ticket correlation)
- 0.5-0.6: Identified partial dependencies but did not form a complete chain \
or missed important impacts
- 0.3-0.4: Only discovered task failures without analyzing dependencies
- 0.0-0.2: Did not effectively analyze the failure chain or analysis is incorrect
"""

    _ROOT_CAUSE_RUBRIC = """\
Evaluate the accuracy of the assistant's root cause identification (0.0-1.0).

## True Root Cause
INT-1501 (Supplier API v2) configured endpoint \
https://supplier-api.example.com/v2/data is no longer available.
The supplier migrated the API from v2 to v3 on 2026-03-20, and the v2 \
endpoint started returning 404.

## Key Information That Must Be Discovered
1. INT-1501 (v2) status is still active, but error_rate=1.0 (100% failure)
2. INT-1501's notes explicitly state "v2 has been returning 404 since \
March 20; the supplier has migrated the API to v3"
3. INT-1502 (v3) already exists with inactive status, endpoint points to \
the new v3 address
4. INT-1502's notes state "new API version is live and has passed \
verification tests, but has not yet been activated in production"
5. JOB-1501's error logs point to the v2 endpoint returning 404

## Root Cause Reasoning Chain
Supplier migrated API (v2->v3) -> system did not follow up with config \
switch -> INT-1501 (v2) requests all fail -> JOB-1501 cannot sync data -> \
entire dependency chain breaks

## Strict Scoring
- 0.9-1.0: Accurately identified root cause as API version not switched \
(v2 deprecated + v3 not activated), cited specific information from INT-1501 \
and INT-1502
- 0.7-0.8: Identified API endpoint issue but did not fully explain the \
v2->v3 migration relationship or did not mention INT-1502 is ready
- 0.5-0.6: Knows it is an API configuration issue but analysis lacks depth
- 0.3-0.4: Stopped at the "JOB-1501 failed" level without digging into \
the configuration layer
- 0.0-0.2: Root cause identification is incorrect or no root cause analysis \
was performed
"""

    _RECOVERY_RUBRIC = """\
Evaluate the completeness and actionability of the assistant's recovery \
plan (0.0-1.0).

## Correct Recovery Plan (should reference KB articles)
### Step 1: Switch API Configuration (refer to KB-1501 migration guide)
- Change INT-1501 (v2) status to inactive/deprecated
- Change INT-1502 (v3) status to active
- Update JOB-1501's data source to point to the v3 endpoint
- Run a test sync to confirm v3 connection works

### Step 2: Restore Data Sync (refer to KB-1503 repair procedure)
- Manually trigger JOB-1501 to perform a full sync
- Confirm JOB-1502 automatically recovers and updates inventory
- Manually trigger JOB-1503 to check restocking needs

### Step 3: Handle Inventory Impact
- Reconcile actual inventory for ITEM-1501/1502/1503
- Pay special attention to ITEM-1503 (network switch) for urgent restocking

### Step 4: Handle Tickets
- Notify reporters of TK-1501/1502/1503 that the issue has been identified \
and a fix is underway
- TK-1504 (printer) should be handled independently; it is unrelated to \
this failure

### Step 5: Preventive Measures
- Monitor API integration error_rate
- Set sync failure alert thresholds

## KB Articles That Must Be Referenced
- KB-1501 (Supplier API Migration Guide): provides specific v2->v3 \
migration steps
- KB-1503 (Inventory Data Desync Repair Procedure): provides manual sync \
and data reconciliation steps
- KB-1502 (Automation Task Dependency Documentation): explains the \
dependency chain and repair priorities

## Strict Scoring
- 0.9-1.0: Plan covers API switch + data sync + inventory handling + ticket \
notification, references KB articles, steps are specific and actionable
- 0.7-0.8: Plan is mostly complete but missing some steps or does not \
reference KB articles
- 0.5-0.6: Gave a general direction but steps lack specificity
- 0.3-0.4: Only vague suggestions without actionable steps
- 0.0-0.2: No recovery plan provided or plan is completely infeasible
"""
