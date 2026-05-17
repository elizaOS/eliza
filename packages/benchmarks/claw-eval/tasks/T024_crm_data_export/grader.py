"""T12en_crm_data_export grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T023zh_crm_data_export")


class CRMDataExportGraderEN(_Base):
    """English variant — overrides language-specific class attributes only."""

    VIP_CUSTOMERS = {
        "CUS-001": {"name": "CloudCreate Tech", "industry": "Technology",
                     "revenue": 5200000, "last_contact": "2026-02-20"},
        "CUS-003": {"name": "SmartLink Electronics", "industry": "Electronics",
                     "revenue": 8900000, "last_contact": "2026-02-25"},
        "CUS-005": {"name": "TianFu Software Park", "industry": "Technology",
                     "revenue": 3600000, "last_contact": "2026-02-27"},
        "CUS-007": {"name": "OpticValley BioTech", "industry": "Biotechnology",
                     "revenue": 12000000, "last_contact": "2026-02-26"},
    }

    VIP_NAME_ALIASES = {
        "CUS-001": ["CloudCreate"],
        "CUS-003": ["SmartLink"],
        "CUS-005": ["TianFu"],
        "CUS-007": ["OpticValley"],
    }

    _REPORT_QUALITY_RUBRIC = """\
Evaluate the VIP customer report quality.
Score each of the three parts separately, then compute a weighted final score (0-1).

=== Part 1: Customer Information Completeness (weight 40%) ===
The report should include all 4 VIP customers, each with 4 fields:
- Customer name
- Industry classification
- Annual revenue
- Last contact date

Reference data:
- CUS-001 CloudCreate Tech: industry=Technology, revenue=5,200,000, last_contact=2026-02-20
- CUS-003 SmartLink Electronics: industry=Electronics, revenue=8,900,000, last_contact=2026-02-25
- CUS-005 TianFu Software Park: industry=Technology, revenue=3,600,000, last_contact=2026-02-27
- CUS-007 OpticValley BioTech: industry=Biotechnology, revenue=12,000,000, last_contact=2026-02-26

Part 1 scoring:
- 0.9-1.0: All 4 customers listed with all 4 fields each
- 0.7-0.8: All 4 customers listed but some fields missing
- 0.5-0.6: 3 customers listed
- 0.3-0.4: Only 1-2 customers listed
- 0.0-0.2: No VIP customers or empty report

=== Part 2: Data Accuracy (weight 35%) ===
Check whether specific data values match the reference:
- Industry classifications correct
- Revenue figures correct (unit conversions like "million" acceptable)
- Dates correct

Part 2 scoring:
- 0.9-1.0: All data fields accurate
- 0.7-0.8: Most data correct, 1-2 minor deviations
- 0.5-0.6: About half the data correct
- 0.3-0.4: Most data inaccurate
- 0.0-0.2: Data seriously wrong or fabricated

=== Part 3: Report Structure (weight 25%) ===
- Uses table or clear structured format
- Has title and sections
- Includes summary information (total revenue, industry distribution, etc.)
- Mentions error recovery process (task involves unstable API)

Part 3 scoring:
- 0.9-1.0: Complete structured report (table+title+summary+error notes)
- 0.7-0.8: Basic table and structure
- 0.5-0.6: Simple list format
- 0.3-0.4: Plain text narrative
- 0.0-0.2: No structure

Output the final weighted score: score = 0.40×Part1 + 0.35×Part2 + 0.25×Part3"""
