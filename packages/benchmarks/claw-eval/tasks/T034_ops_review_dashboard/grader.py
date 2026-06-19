"""T17en_ops_review_dashboard grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T033zh_ops_review_dashboard")


class OpsReviewDashboardGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    # ------------------------------------------------------------------ #
    # Product / customer names (English)
    # ------------------------------------------------------------------ #
    PRODUCT_NAME = "Smart Camera Pro"
    VIP_CUSTOMER_NAME = "Yongkang Smart"

    STALE_KB_ID = "KB-301"
    REPORT_SECTIONS = [
        "integration", "ticket", "inventory", "customer", "scheduler", "knowledge base",
    ]

    # ------------------------------------------------------------------ #
    # LLM Judge rubrics (English)
    # ------------------------------------------------------------------ #

    _CROSS_SYSTEM_RUBRIC = """\
Evaluate whether the agent discovered the unified product quality crisis \
for "Smart Camera Pro" spanning multiple systems.

Correlated data across three systems:
1. Helpdesk: TK-1701 (firmware crash), TK-1702 (blurry image returns), \
TK-1705 (VIP bulk return of 89 units), TK-1707 (WiFi instability) — \
4 of 8 tickets point to the same product
2. Inventory: PRD-201 Smart Camera Pro has 18.5% return rate \
(industry average ~3%)
3. CRM: CUS-301 Yongkang Smart (VIP, 12M annual revenue) complained \
about 89 faulty units out of 500, threatened to terminate contract

Core test: Did the agent connect data from all three systems and identify \
this as a unified product quality crisis, rather than reporting each \
system's issues in isolation?

Scoring:
- 0.9-1.0: Explicitly linked all three systems, identified Smart Camera Pro \
as the cross-system core issue, with synthesis language
- 0.7-0.8: Linked two systems, or mentioned all but without explicit correlation
- 0.4-0.6: Reported each system independently without connecting them
- 0.1-0.3: Only mentioned partial data, no correlation analysis
- 0.0: Did not mention Smart Camera Pro issues at all"""

    _ANOMALY_DETECTION_RUBRIC = """\
Evaluate whether the agent discovered hidden system anomalies that require \
deeper analysis beyond surface-level metrics.

Four anomalies to find:

1. INT-102 (crm_sync) — metric vs status contradiction:
   - Status label shows "active" but error rate is 12%
   - The status label is misleading; actual metrics need attention

2. INT-107 (search_indexer) — silent failure:
   - Error rate 0% looks healthy, but call volume dropped from 1500 to 15 (99% drop)
   - Service is effectively dead but shows no errors because nothing calls it

3. JOB-103 (inventory_sync) — consecutive failures:
   - Failed 3 consecutive times with timeout errors
   - May correlate with INT-107's volume drop

4. JOB-105 (crm_data_export) — stale execution:
   - Has not run in over 5 days
   - Scheduled job may have silently stopped

Bonus:
- Discovered correlation between JOB-103 and INT-107
- Noted KB-301 quality control doc is outdated (August 2025, 6+ months old)

Scoring:
- 0.9-1.0: Found all 4 anomalies with deep analysis (e.g., INT-107 "looks \
healthy but effectively dead" insight, JOB-103/INT-107 correlation)
- 0.7-0.8: Found 3-4 anomalies with some deep analysis
- 0.5-0.6: Found 2-3 anomalies, shallow analysis
- 0.2-0.4: Only found 1-2 obvious anomalies (e.g., INT-105 degraded), \
missed hidden issues
- 0.0-0.1: No anomalies found or only surface-level reporting"""

    _ACTION_ITEMS_RUBRIC = """\
Evaluate the quality of the agent's action items / recommendations.

Good recommendations should:
1. Reference specific anomalies and IDs (PRD-201, INT-102, JOB-103, etc.)
2. Prioritize (Smart Camera Pro quality crisis should be highest priority)
3. Specify concrete next steps ("investigate INT-107 volume drop", \
"contact Yongkang Smart VIP for retention")
4. Cover multiple problem areas (product, system health, scheduler, etc.)

Scoring:
- 0.8-1.0: Specific, prioritized, data-backed recommendations covering \
multiple areas
- 0.5-0.7: Has recommendations but some are vague or miss important areas
- 0.2-0.4: Generic advice lacking specific references, covers few issues
- 0.0-0.1: No recommendations or action items"""

    _ANALYSIS_QUALITY_RUBRIC = """\
Evaluate the depth and accuracy of the agent's analysis across systems.

Key analysis points per system:

1. Ticket analysis:
   - Identified 4 of 8 tickets (TK-1701, TK-1702, TK-1705, TK-1707) \
concern Smart Camera Pro
   - Recognized the clustering trend (not random, pointing to one product)
   - Noted TK-1705 involves VIP bulk returns

2. Inventory analysis:
   - PRD-201 has 18.5% return rate, far above normal
   - PRD-204 has low stock
   - Return rate aligns with helpdesk complaint trends

3. CRM VIP analysis:
   - CUS-301 Yongkang Smart is VIP (12M annual revenue)
   - Complaint: 89 faulty units out of 500, threatened contract termination
   - Customer churn risk directly tied to product quality

4. Knowledge base:
   - KB-301 camera quality control doc outdated (August 2025, 6+ months old)

Scoring:
- 0.8-1.0: Thorough analysis across systems, accurate data, deep insights
- 0.5-0.7: Most systems analyzed but some data missing or shallow
- 0.2-0.4: Only superficial reporting on some systems
- 0.0-0.1: Analysis severely lacking or data errors"""

    _REPORT_STRUCTURE_RUBRIC = """\
Evaluate the structural quality and professionalism of the agent's report.

A good ops weekly report should have:
1. Clear section structure covering: integrations, tickets, inventory, \
customers, scheduler, knowledge base
2. Professional formatting: headings, tables, lists
3. Substantive content: not just data, but analysis and conclusions
4. Key issues highlighted prominently (product quality crisis)
5. Data-backed: specific numbers and IDs, not just qualitative descriptions

Scoring:
- 0.8-1.0: Complete structure (most sections covered), professional format, \
key issues highlighted, data-backed
- 0.5-0.7: Basic structure but missing sections, or format not clear enough
- 0.2-0.4: Loose structure, multiple sections missing, or plain text only
- 0.0-0.1: No structure, minimal content, or doesn't look like a report"""
