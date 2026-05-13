"""T106_job_failure_triage grader — English variant of T140zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T105zh_job_failure_triage")


class JobFailureTriageGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only.

    All scoring logic (tool gates, LLM judge calls, weighting) is inherited
    from the ZH base grader unchanged.
    """

    _CORRELATION_RUBRIC = """\
Evaluate the accuracy of the assistant's correlation between scheduled job failures and tickets (0.0-1.0).

## Correct 3 correlation groups (each must identify both the failed job and corresponding tickets)

Correlation 1 — ERP failure chain (most important):
- JOB-302 (order sync to ERP) started failing consecutively from 17:30, error: ConnectionRefusedError: ERP endpoint unreachable
- TK-401 (ERP system inaccessible) reported at 17:35, 503 error
- TK-403 (ERP order data not updating) reported at 19:00, last data stopped at 17:00
- Correct analysis: all three share a common root cause — ERP service failed around 17:20, timeline is consistent

Correlation 2 — Email failure:
- JOB-303 (daily report email) failed at 09:00, error: SMTPAuthenticationError: SMTP credentials expired
- TK-402 (daily report email not received) reported at 10:15
- Correct analysis: expired SMTP credentials caused email delivery failure

Correlation 3 — Disk failure:
- JOB-305 (user behavior log archival) disabled, last two runs failed, error: disk usage 97-98%
- TK-405 (disk space alert) reported at 08:30, /data/archive partition at 98%
- Correct analysis: insufficient disk space in the archive directory caused archival job failure

## Distractors
- TK-404 (printer paper jam): must be identified as an independent issue unrelated to scheduled jobs
- JOB-301 (database backup) and JOB-304 (inventory check): running normally, should not be listed as failures

## Strict scoring
- 0.9-1.0: All 3 correlations correct, precise timeline analysis, TK-404 excluded
- 0.7-0.8: All 3 correlations basically correct, but missing timeline details or TK-404 not explicitly excluded
- 0.5-0.6: Only 2 correlations correctly identified
- 0.3-0.4: Only 1 correlation correctly identified
- 0.0-0.2: Correlations wrong (linking unrelated items together) or no correlation analysis done
"""

    _PRIORITY_RUBRIC = """\
Evaluate whether the assistant's fault handling priority recommendations are reasonable (0.0-1.0).

Correct priority order and rationale:
1. Highest priority — ERP failure (JOB-302 + TK-401/403):
   - Affects multiple departments (Finance Dept, Warehouse Dept), blocking core business processes
   - Has persisted for hours, tickets are critical and high
   - Should immediately investigate ERP service status

2. Medium priority — Disk alert (JOB-305 + TK-405):
   - 98% usage, job already disabled
   - If not addressed promptly, will affect other services
   - Needs cleanup or expansion

3. Lower priority — Email credentials (JOB-303 + TK-402):
   - Only affects daily report delivery, not a core business function
   - Fix is straightforward (update SMTP credentials)

4. TK-404 printer issue: lowest priority, unrelated to system failures

## Strict scoring
- 0.9-1.0: Correct ordering with sufficient rationale for each priority level
- 0.6-0.8: Roughly correct ordering but rationale insufficient
- 0.3-0.5: Obvious ordering errors (e.g., putting email ahead of ERP)
- 0.0-0.2: No priority recommendations given or completely wrong
"""

    _REPORT_RUBRIC = """\
Evaluate the structure and actionability of the final report (0.0-1.0).

A qualifying report must include:
1. Clear description of each fault group: failed job -> correlated tickets -> root cause -> scope of impact
2. Handling priority ranking
3. Specific remediation recommendations (not generic advice, but concrete actions for each fault)
4. Clear formatting (grouped listings or table format, not a jumbled paragraph)

## Strict scoring
- 0.9-1.0: Clear structure, all 4 items included, recommendations are specific and actionable
- 0.6-0.8: Contains 3 items, format is mostly clear
- 0.3-0.5: Only partial content, messy format or overly generic recommendations
- 0.0-0.2: No complete report produced
"""
