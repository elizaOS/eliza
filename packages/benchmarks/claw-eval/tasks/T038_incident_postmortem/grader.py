"""T19en_incident_postmortem grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T037zh_incident_postmortem")


class IncidentPostmortemGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    # ------------------------------------------------------------------ #
    # LLM Judge rubrics (English)
    # ------------------------------------------------------------------ #

    _ROOT_CAUSE_RUBRIC = """\
Evaluate whether the agent correctly identified the root cause of the incident.

The true root cause (all must be identified for full marks):
1. CRM data sync scheduled job (crm_data_sync / JOB-301) ran at 20:00
2. It contained an unoptimized SQL query (full table scan, no index)
3. This SQL was introduced in a Friday deployment (Feb 27)
4. The SQL consumed excessive DB connections, exhausting the pool (200/200)
5. Pool exhaustion caused cascading failures: API timeouts, payment 503s, \
order failures, task queue backlog

Key distinction: The agent must identify the CRM sync SQL issue as the root \
cause, not merely report "database connection pool exhaustion" (which is a symptom).

Scoring:
- 0.9-1.0: Accurately pinpointed CRM sync's SQL full table scan as root cause, \
linked to TK-1908 and/or JOB-301 evidence
- 0.7-0.8: Identified CRM sync as the source but SQL details incomplete
- 0.4-0.6: Identified DB connection pool issue but didn't trace back to CRM sync SQL
- 0.1-0.3: Only described symptoms (payment failures, timeouts), no root cause
- 0.0: No root cause analysis at all"""

    _CAUSAL_CHAIN_RUBRIC = """\
Evaluate whether the agent constructed a complete causal chain.

Correct causal chain (4 links):
1. Trigger: 20:00 scheduled job (JOB-301/crm_data_sync) started automatically
2. Root cause: Executed unoptimized SQL (full table scan, new code, no DBA review)
3. Direct impact: SQL consumed massive DB connections -> pool exhausted (200/200)
4. Cascading failures: API timeouts -> payment service 503 -> ~200 order failures \
-> Celery task queue backlog of ~50,000

Recovery: DBA manually killed CRM sync process at 21:30 -> services recovered by 21:35

Core test: Did the agent connect these events into a causal chain rather than \
listing symptoms in isolation?

Scoring:
- 0.9-1.0: Complete 4-link chain with clear logic and recovery description
- 0.7-0.8: Chain mostly complete but one link unclear
- 0.4-0.6: Mentioned most events but causal relationships not explicit
- 0.1-0.3: Only listed some symptoms without causal connections
- 0.0: No causal analysis"""

    _IMPACT_PROCESS_RUBRIC = """\
Evaluate the agent's impact assessment and process gap identification.

Incident impact (should cover):
- Payment service returning 503 errors
- ~200 orders failed
- User complaints increased, support tickets surged
- Celery task queue backlog of ~50,000
- Service disruption ~75 minutes (20:15 to 21:35)

Process gaps (should identify):
1. CRM sync SQL change skipped DBA performance review
2. DBA raised performance testing concerns at release review but was overruled \
(time pressure)
3. Friday deployment introduced insufficiently tested code
4. Same pattern as December incident (KB-603) — systemic process failure

Scoring:
- 0.8-1.0: Comprehensive impact with data, deep process gap analysis \
(review skip + DBA overruled + systemic issue)
- 0.5-0.7: Both impact and process gaps covered but not comprehensive
- 0.2-0.4: Only mentioned partial impact or process issues
- 0.0-0.1: No impact assessment or process gap identification"""

    _PREV_INCIDENT_IMPROVEMENTS_RUBRIC = """\
Evaluate whether the agent linked to the previous incident and proposed \
effective improvements.

Previous incident link:
- KB-603 documents a similar December 2025 incident
- Improvement action "migrate CRM to read replica" was marked TODO but never done
- This incident is essentially the same problem recurring — improvements never landed

Expected recommendations:
1. Add index for CRM sync SQL (immediate fix)
2. Complete CRM read replica migration (root fix from KB-603 TODO)
3. Set per-job DB connection limits/isolation (prevent single job exhausting pool)
4. Enforce mandatory DBA performance review for all SQL changes (process fix)

Scoring:
- 0.8-1.0: Referenced KB-603, identified unfinished TODO, proposed at least \
3 of 4 improvement categories
- 0.5-0.7: Mentioned previous incident or proposed some improvements, but incomplete
- 0.2-0.4: Few improvement suggestions without historical context
- 0.0-0.1: No improvements or no mention of history"""

    _REPORT_QUALITY_RUBRIC = """\
Evaluate the structure and professionalism of the agent's postmortem report.

A good incident postmortem should contain:
1. Incident summary: brief description of what happened
2. Timeline: chronological key events with timestamps and ticket IDs
3. Root cause analysis: specific root cause, not just symptoms
4. Causal chain: complete logic from trigger to impact
5. Impact scope: quantified business impact
6. Process analysis: why it happened, process failures
7. Improvement recommendations: short-term and long-term fixes

Format: structured with clear sections, timeline with timestamps

Scoring:
- 0.8-1.0: Covers most sections above, professional format, clear logic, \
includes timeline
- 0.5-0.7: Basic structure but some sections missing
- 0.2-0.4: Scattered content, missing key sections
- 0.0-0.1: Does not resemble a formal postmortem report"""
