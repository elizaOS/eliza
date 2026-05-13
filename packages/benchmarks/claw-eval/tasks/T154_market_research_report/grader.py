"""T154_market_research_report grader — English variant of T188zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T153zh_market_research_report")


class MarketResearchReportGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _BREADTH_RUBRIC = """\
Evaluate the breadth and completeness of the assistant's information gathering (0.0-1.0).

## RSS Industry News (should cover at least 6 of 8 key articles)
1. RSS-1201: AI adoption accelerating (enterprise AI tools up 120%, manufacturing + healthcare fastest)
2. RSS-1202: Hybrid cloud trend (78% enterprises adopting, manufacturing + healthcare demand strong)
3. RSS-1203: SaaS renewal rates declining (NRR 118% -> 109%, SME churn 22%) ★ RISK
4. RSS-1204: Manufacturing digital investment up 35%
5. RSS-1205: SME IT spending growing (SaaS penetration 42%)
6. RSS-1206: Healthcare IT policy (Tier-A hospital upgrades, 50B CNY market)
7. RSS-1207: Education digitization (AI teaching tools, limited budgets)
8. RSS-1208: Fintech regulation tightening (Level-3 security compliance -> our advantage)

## KB Internal Documents (should cover all 5)
1. KB-1201: 2025 annual market data (industry distribution baseline)
2. KB-1202: Product competitiveness (AI lagging -> Q2 plan)
3. KB-1203: Target industry strategy (manufacturing/healthcare/education)
4. KB-1204: Customer profiles (VIP renewal 92%, standard 78%)
5. KB-1205: Q1 sales data (industry performance)

## CRM Customer Data
- Whether customer list was retrieved and industry distribution analyzed
- 8 customers: manufacturing 3 + healthcare 2 + education 2 + finance 1

## Emails
- msg_1201: CEO's report request
- msg_1202: VP Sales feedback on manufacturing AI demand

## Strict scoring
- 0.9-1.0: RSS >= 6 articles + KB = 5 articles + CRM customer data + both emails read
- 0.7-0.8: RSS >= 4 articles + KB >= 3 articles + CRM data + at least 1 email
- 0.4-0.6: Partial data source coverage, many omissions
- 0.0-0.3: Only covered 1-2 data sources
"""

    _STRATEGY_RUBRIC = """\
Evaluate the depth of strategic analysis and cross-data-source correlation (0.0-1.0).

## Three Core Trends That Must Be Identified

### Trend 1: AI Acceleration -> Manufacturing is the Biggest Opportunity
- External signal: AI tools up 120% (RSS-1201), manufacturing investment +35% (RSS-1204)
- CRM validation: 3 manufacturing customers (2 VIP), Dingsheng Machinery evaluating Competitor A's AI
- Internal capability: AI lagging competitors (KB-1202), but Q2 launch planned
- Sales feedback (msg_1202): Customers proactively asking about AI features
- Strategic recommendation: Accelerate AI capability development, prioritize manufacturing VIP customers

### Trend 2: Healthcare IT -> Policy-Driven Growth
- External signal: Tier-A hospital upgrades 50B CNY market (RSS-1206), hybrid cloud demand (RSS-1202)
- CRM validation: 2 healthcare customers, VIP Tier-A hospital group
- Internal data: Healthcare grew 35% in 2025 (KB-1201), second priority (KB-1203)
- Strategic recommendation: Seize policy window, deepen healthcare vertical

### Trend 3: SaaS Renewal Rate Declining -> Risk Warning
- External signal: NRR dropped from 118% to 109% (RSS-1203), SME churn 22%
- CRM validation: Education sector already has churn (CUS-1207)
- Internal data: Q1 renewal rate down 3% (KB-1205), standard customer renewal 78% (KB-1204)
- Strategic recommendation: Strengthen customer success programs, focus on preventing standard customer churn

## Cross-Source Correlation Quality
- Whether RSS external trends were compared against CRM internal customer data
- Whether KB historical data was contrasted with latest RSS information to identify changes
- Whether sales feedback (email) was connected with customer data (CRM) and industry trends (RSS)

## Strict scoring
- 0.9-1.0: All three trends complete, deep cross-source correlation, data-backed strategic recommendations
- 0.6-0.8: 2-3 trends identified, some correlation analysis
- 0.3-0.5: Only listed information without cross-analysis
- 0.0-0.2: Fragmented information, no strategic insights
"""

    _DELIVERABLE_RUBRIC = """\
Evaluate the quality of the final deliverables (0.0-1.0).

## Market Research Report
1. Clear structure: Distinct sections (industry trends, customer analysis, competitive landscape, strategic recommendations, etc.)
2. Data-backed: Key conclusions supported by specific data (growth rates, customer counts, revenue share)
3. Action-oriented: Each trend has corresponding strategic recommendations with priorities
4. Risk identification: Not only opportunities but also risks like renewal rate decline

## Email Draft
1. Correct recipients: Should include all management (CEO Zhang, CTO Li, CMO Wang, VP Sales Zhao)
2. Whether contacts service was queried to get email addresses
3. Clear subject: Reflects Q1 market research report
4. Concise body: Includes report summary, key findings, recommendation highlights
5. Professional tone: Appropriate for executive-level communication

## Strict scoring
- 0.9-1.0: Report structured + data sufficient + recommendations solid, email recipients correct and content professional
- 0.6-0.8: Report basically complete, email draft exists but lacks detail
- 0.3-0.5: Report or email missing one component
- 0.0-0.2: Deliverables incomplete
"""
