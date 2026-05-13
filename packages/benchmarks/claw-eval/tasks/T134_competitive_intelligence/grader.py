"""T134_competitive_intelligence grader — English variant of T168zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T133zh_competitive_intelligence")


class CompetitiveIntelligenceGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _COVERAGE_RUBRIC = """\
Evaluate the assistant's information coverage of competitive dynamics (0.0-1.0).

## Must-Cover Information for Competitor A
1. RSS-401: Version 4.0 release with AI assistant features
2. RSS-402: Benchmark results (AI accuracy 85%, performance improvement 30%)
3. RSS-403: CEO strategy — 40% of budget allocated to AI
4. KB-801: Historical comparative analysis (note that "no AI capability" is outdated)

## Must-Cover Information for Competitor B
1. RSS-404: Series C funding of 500M
2. RSS-405: Southeast Asia expansion
3. KB-802: Historical market analysis (note that "overseas expansion limited" is outdated)

## Additional Information Integration
- msg_901: Product manager's report requirements
- msg_902: Sales feedback from the field (clients are paying attention to Competitor A's AI)
- KB-803: Our product strengths

## Strict Scoring
- 0.9-1.0: All 7 core information items covered
- 0.7-0.8: 5-6 items
- 0.4-0.6: 3-4 items
- 0.0-0.3: Fewer than 3 items
"""

    _DEPTH_RUBRIC = """\
Evaluate the depth and insightfulness of the analysis (0.0-1.0).

## A Deep Analysis Should Include
1. Discrepancies between KB historical analysis and RSS new information (e.g., "KB-801 says no AI capability, but RSS shows it has been released")
2. Specific threat assessment of competitor dynamics on our company
3. Integration of frontline sales feedback (clients have noticed competitor AI features)
4. Our response strategy (incorporating KB-803's AI Q2 launch plan)
5. Broader market trends (RSS-406 SaaS market growth) connection

## Strict Scoring
- 0.9-1.0: All 5 points covered with deep insights
- 0.6-0.8: 3-4 points
- 0.3-0.5: 1-2 points
- 0.0-0.2: Just information listing without analysis
"""

    _DELIVERABLE_RUBRIC = """\
Evaluate the quality of the final deliverable (0.0-1.0).

## Acceptable Deliverable
1. Structured competitive intelligence report (organized by competitor)
2. Threat level assessment for each competitor
3. Recommended responses for our company (short-term + medium-term)
4. Email draft (version for management)

## Strict Scoring
- 0.9-1.0: All 4 items included, professional report
- 0.6-0.8: 3 items included
- 0.3-0.5: 1-2 items included
- 0.0-0.2: No complete deliverable produced
"""
