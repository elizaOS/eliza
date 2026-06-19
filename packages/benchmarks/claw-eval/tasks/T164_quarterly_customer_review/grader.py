"""T164_quarterly_customer_review grader — English variant of T198zh."""
from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T163zh_quarterly_customer_review")


class QuarterlyCustomerReviewGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _CUSTOMER_ANALYSIS_RUBRIC = """\
Evaluate the accuracy of the assistant's comprehensive analysis of Q1 data for all 6 customers (0.0-1.0).

## Correct Q1 Revenue Analysis
| Customer | Jan | Feb | Mar | Q1 Total | Trend |
|----------|-----|-----|-----|----------|-------|
| CUS-1601 Dingxin Software (VIP) | 80,000 | 85,000 | 90,000 | 255,000 | Up — steady growth (+12.5%) |
| CUS-1602 Hanhai E-commerce | 50,000 | 50,000 | 45,000 | 145,000 | Down — slight decline (-10%) |
| CUS-1603 Wantong Logistics (VIP) | 120,000 | 125,000 | 130,000 | 375,000 | Up — stable growth (+8.3%), largest customer |
| CUS-1604 Qianfeng Technology | 35,000 | 30,000 | 0 | 65,000 | Down — zero revenue in March |
| CUS-1605 Sunshine Media (VIP) | 60,000 | 65,000 | 70,000 | 195,000 | Up — rapid growth (+16.7%) |
| CUS-1606 Public Institution | 40,000 | 40,000 | 40,000 | 120,000 | Flat — no change |

## CRM Information That Must Be Integrated
- CUS-1604: Satisfaction 2.5/5 (lowest), contract expires April 15
- CUS-1602: Satisfaction 3.2/5 (below average), contract expires June 30
- CUS-1603: Satisfaction 4.8/5 (highest), VIP largest customer
- CUS-1601: Satisfaction 4.5/5, VIP core customer

## Email Communication Clues That Must Be Integrated
- Dingxin: Renewal discussion (msg_1601) + project progress report (msg_1602)
- Hanhai: Complaint about slow response (msg_1603) + new feature inquiry (msg_1604)
- Wantong: Service appreciation (msg_1605) + expansion discussion (msg_1606)
- Qianfeng: No response after last communication on January 20 (msg_1607)
- Sunshine: Q1 review + AI application results (msg_1608)
- Public: Budget inquiry in February (msg_1609)

## Strict Scoring
- 0.9-1.0: Revenue + CRM + email analysis across all 3 dimensions is fully accurate and complete for all 6 customers
- 0.7-0.8: Revenue analysis is correct, CRM and email information covers most customers
- 0.5-0.6: Revenue data is correct but missing CRM or email cross-analysis
- 0.3-0.4: Only listed partial data without comprehensive analysis
- 0.0-0.2: Data is significantly missing or inaccurate
"""

    _RISK_OPPORTUNITY_RUBRIC = """\
Evaluate the accuracy of the assistant's identification of risk and growth customers (0.0-1.0).

## Risk Customers That Must Be Identified
1. CUS-1604 Qianfeng Technology = High churn risk (must be flagged as highest risk)
   Evidence chain: Zero March revenue + satisfaction only 2.5/5 + contract expires April 15 (less than 1 month) + communication breakdown since January + industry (manufacturing) IT budget cuts
2. CUS-1602 Hanhai E-commerce = Medium risk
   Evidence chain: Revenue declined from 50k to 45k + satisfaction 3.2/5 + complaint about slow service response (msg_1603) + industry (e-commerce) intensifying competition

## Growth Customers That Must Be Identified
3. CUS-1603 Wantong Logistics = Greatest growth opportunity
   Evidence chain: Largest customer (Q1 total 375k) + stable growth + satisfaction 4.8 (highest) + discussing expansion plans + industry (logistics) increasing digitalization investment
4. CUS-1601 Dingxin Software = Steady growth
   Evidence chain: Stable growth (80k -> 90k) + VIP + discussing renewal + industry (software) high growth
5. CUS-1605 Sunshine Media = Rapid growth
   Evidence chain: Fastest growth rate (+16.7%) + successful AI adoption + industry (media) AI-driven growth

## Stable Customer
6. CUS-1606 Public Institution = Stable, no fluctuation
   Evidence chain: Flat at 40k for all 3 months + satisfaction 3.8 + industry (government) steady progress

## Strict Scoring
- 0.9-1.0: CUS-1604 flagged as highest risk + CUS-1602 flagged as medium risk + all 3 growth customers identified + evidence chains provided
- 0.7-0.8: Identified 2 risk + 2 growth customers with partial evidence
- 0.5-0.6: Identified the primary risk (CUS-1604) and at least 1 growth customer
- 0.3-0.4: Only identified some risks or growth opportunities without analysis
- 0.0-0.2: Failed to effectively identify risks and opportunities
"""

    _REPORT_QUALITY_RUBRIC = """\
Evaluate the completeness and quality of the customer review report (0.0-1.0).

## Required Report Elements
1. Customer-by-customer analysis (all 6 customers covered)
2. Industry trends correlation (at least 4 customer-industry matches)
   - Dingxin <-> software growth, Hanhai <-> e-commerce competition, Wantong <-> logistics digitalization, Qianfeng <-> manufacturing budget cuts, Sunshine <-> media AI, Public <-> government informatization
3. Account manager mapping
   - Zhao Lei responsible for VIP: CUS-1601 Dingxin, CUS-1603 Wantong, CUS-1605 Sunshine
   - Zhang Wei responsible for standard: CUS-1602 Hanhai, CUS-1604 Qianfeng, CUS-1606 Public
4. Risk alerts and recommended actions (e.g., CUS-1604 requires urgent follow-up, CUS-1602 needs improved service response)
5. Growth opportunities and action plans (e.g., push expansion for CUS-1603, deepen AI collaboration with CUS-1605)
6. Clear report structure with categorization and data-backed analysis

## Strict Scoring
- 0.9-1.0: All 6 elements covered, clear and professional report structure, accurate data references
- 0.7-0.8: At least 5 elements, good structure
- 0.5-0.6: At least 3 elements but lacking in structure or depth
- 0.3-0.4: Few elements covered or too superficial
- 0.0-0.2: Report is incomplete or poor quality
"""
