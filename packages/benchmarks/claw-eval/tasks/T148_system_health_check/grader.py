"""T148_system_health_check grader — English variant of T182zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T147zh_system_health_check")


class SystemHealthCheckGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only.

    All scoring logic (tool gates, LLM judge calls, weighting) is inherited
    from the ZH base grader unchanged.
    """

    _HEALTH_ASSESSMENT_RUBRIC = """\
Evaluate the accuracy of the assistant's system health status assessment (0.0-1.0).

## Integration Configuration Status (5 total)
- INT-1001 Payment Gateway: active, error_rate 0.02 -> Healthy
- INT-1002 Email Service: error, SMTP authentication expired -> Faulty (critical issue)
- INT-1003 Data Warehouse Sync: active, error_rate 0.28 -> High error rate (requires immediate investigation)
- INT-1004 Message Queue: active, error_rate 0.01 -> Healthy
- INT-1005 Logging Service: active, error_rate 0.005 -> Healthy

## Scheduled Job Status (6 total)
- JOB-1001 Data Backup: enabled, success -> Normal
- JOB-1002 Email Notifications: enabled, failed, 12 consecutive failures (since 3/19) -> Faulty
- JOB-1003 Data Warehouse ETL: enabled, failed, 6 consecutive failures (since 3/23) -> Faulty
- JOB-1004 Monitoring Check: enabled, success -> Normal
- JOB-1005 Log Cleanup: enabled, success -> Normal
- JOB-1006 Report Generation: disabled, under maintenance (expected to resume 3/28) -> Suspended

## Ticket Overview (6 open)
- TK-1001 Not receiving emails (high), TK-1002 Report delay (medium), TK-1003 Blank reports (medium)
- TK-1004 Slow login (high), TK-1005 Push notification anomaly (low), TK-1006 Storage expansion request (low)

## Strict scoring
- 0.9-1.0: All integration and job statuses correctly identified, abnormalities clearly marked, all tickets covered
- 0.7-0.8: Identified INT-1002 fault and INT-1003 high error rate, job failures basically correct
- 0.5-0.6: Identified major anomalies but missed some details (e.g., JOB-1006 disabled reason)
- 0.3-0.4: Only listed some abnormal items
- 0.0-0.2: Health status assessment not completed
"""

    _CORRELATION_DEPTH_RUBRIC = """\
Evaluate the depth of the assistant's fault chain correlation analysis (0.0-1.0).

## Fault chains that must be discovered

### Chain 1: SMTP Email Service Fault Chain
- Root cause: INT-1002 Email Service SMTP authentication expired (faulty since 3/18)
- Impact 1: JOB-1002 Email notification job failed (SMTP connection timeout, 12 failures, since 3/19)
- Impact 2: TK-1001 User not receiving system notification emails (reported 3/24)
- Impact 3: TK-1005 Mobile push notification anomaly (push relies on email service channel)
- KB match: KB-1001 SMTP Service Troubleshooting Guide

### Chain 2: Data Warehouse Sync Fault Chain
- Root cause: INT-1003 Data Warehouse Sync error rate as high as 28%
- Impact 1: JOB-1003 ETL job sync timeout failure (6 failures, since 3/23)
- Impact 2: TK-1002 Data report delayed updates
- KB match: KB-1002 Data Warehouse Sync Optimization Guide

### Independent Correlations
- JOB-1006 Report generation job disabled on 3/21 (maintenance) -> TK-1003 Report page blank since 3/21 (timeline match)
- TK-1004 Slow login -> Independent performance issue, no direct connection to integrations/jobs -> KB-1003 may help
- TK-1006 Storage expansion request -> Internal need -> KB-1004 may help

## Strict scoring
- 0.9-1.0: Both complete fault chains (INT->JOB->TK) fully discovered, independent correlations also correct, KB matches accurate
- 0.7-0.8: Discovered both fault chains but missing some links (e.g., missed TK-1005 belonging to Chain 1)
- 0.5-0.6: Discovered one complete fault chain, the other incomplete
- 0.3-0.4: Found some anomaly correlations but did not form complete chains
- 0.0-0.2: No correlation analysis performed
"""

    _ACTION_PLAN_RUBRIC = """\
Evaluate the quality of repair recommendations and action plan (0.0-1.0).

## Required repair recommendations

### Urgent Fix (Chain 1 -- SMTP)
1. Immediately fix INT-1002 SMTP authentication (ref KB-1001: regenerate credentials, update config, restart service)
2. After fix, verify JOB-1002 email notification job resumes normally
3. Notify TK-1001 and TK-1005 users that email/push will be restored

### Important Fix (Chain 2 -- ETL)
4. Investigate INT-1003 data warehouse sync high error rate (ref KB-1002: optimize ETL, increase timeout threshold)
5. After fix, verify JOB-1003 ETL job resumes, notify TK-1002 user

### Other Actions
6. Confirm JOB-1006 report generation job will resume as planned on 3/28, notify TK-1003 user of expected recovery time
7. TK-1004 slow login needs separate investigation (ref KB-1003 performance tuning manual)
8. TK-1006 storage expansion follows standard process (ref KB-1004 expansion manual)

### System-Level Recommendations
9. Establish integration health monitoring alerts, auto-notify when error_rate exceeds threshold
10. Scheduled jobs with consecutive failures should auto-alert (currently JOB-1002 failed 12 times before being found in monthly check)

## Strict scoring
- 0.9-1.0: Urgent/important fixes comprehensive, KB solutions referenced, systemic improvement suggestions included
- 0.7-0.8: Main repair recommendations complete, but missing systemic suggestions or KB references
- 0.5-0.6: Provided fix direction but not specific enough
- 0.3-0.4: Recommendations too generic, lacking specificity
- 0.0-0.2: No effective recommendations given
"""
