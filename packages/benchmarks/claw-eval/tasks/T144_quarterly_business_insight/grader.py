"""T144_quarterly_business_insight grader — English variant of T178zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T143zh_quarterly_business_insight")


class QuarterlyBusinessInsightGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _DATA_RUBRIC = """\
Evaluate the accuracy of the assistant's Q1 revenue data analysis (0.0-1.0).

## Correct Revenue Analysis
| Customer | Jan | Feb | Mar | Q1 Total | Trend |
|----------|------|------|------|----------|-------|
| CUS-901 Dingxin Software | 85,000 | 90,000 | 95,000 | 270,000 | Growing |
| CUS-902 Hanhai E-Commerce | 45,000 | 45,000 | 45,000 | 135,000 | Flat |
| CUS-903 Wantong Logistics | 120,000 | 120,000 | 115,000 | 355,000 | Slight decline |
| CUS-904 Qianfeng Tech | 30,000 | 30,000 | 25,000 | 85,000 | Declining |
| CUS-905 Sunlight Media | 60,000 | 65,000 | 70,000 | 195,000 | Growing |
| CUS-906 Public Institution | 0 | 0 | 0 | 0 | Churned |

## Total revenue: Q1 total 1,040,000 CNY

## Strict scoring
- 0.9-1.0: Complete per-customer summary, trend classification correct (2 growing/1 flat/2 declining/1 churned), quantitative comparison
- 0.7-0.8: Data roughly correct, trend judgments mostly accurate
- 0.5-0.6: Listed data but incomplete trend analysis
- 0.3-0.4: Data errors or multiple customers omitted
- 0.0-0.2: Did not effectively analyze revenue data
"""

    _CORRELATION_RUBRIC = """\
Evaluate the depth of correlation analysis between customer revenue changes and industry dynamics (0.0-1.0).

## Correct Correlation Pairs
1. Dingxin (Software) <-> RSS-901 (Software industry growth 12%) -> industry tailwind driving growth
2. Hanhai (E-Commerce) <-> RSS-902 (E-commerce traffic growth slowing) -> industry slowdown causing flat demand
3. Wantong (Logistics) <-> RSS-903 (Logistics price competition/margin pressure) -> explains price sensitivity and slight decline
4. Qianfeng (Manufacturing) <-> RSS-904 (Manufacturing IT budget tightening) -> industry headwind causing downgrade
5. Sunlight (Media) <-> RSS-905 (Media AI-driven growth) -> AI tailwind driving expansion
6. Public (Government) <-> RSS-906 (Government budget adjustments) -> budget cuts causing churn

## Strict scoring
- 0.9-1.0: All 6 correlation pairs correct, clear causal analysis logic
- 0.7-0.8: At least 4 pairs correct
- 0.5-0.6: 3 pairs correct
- 0.3-0.4: Only 1-2 pairs correct or analysis is superficial
- 0.0-0.2: Did not correlate industry dynamics with customer data
"""

    _INSIGHT_RUBRIC = """\
Evaluate the quality of Q2 forecast and recommendations (0.0-1.0).

## Required Insights
1. Risk alert: CUS-904 contract expiring April + revenue declining + industry headwind = high churn risk
2. Risk alert: CUS-903 VIP but price-sensitive, need to prevent downgrade
3. Growth opportunity: CUS-905 fastest growth (+16.7%), can upsell more value-added services
4. Growth opportunity: CUS-901 continuous expansion, VIP value increasing
5. Watch item: CUS-902 flat with no growth, e-commerce slowdown needs renewal attention
6. Churn review: CUS-906 churned due to budget issues, similar customers need prevention

## Strict scoring
- 0.9-1.0: All 6 insights covered, Q2 recommendations are actionable
- 0.7-0.8: At least 4 insights, reasonable recommendations
- 0.5-0.6: Identified main risks and opportunities but not deep enough
- 0.3-0.4: Only provided data summary without deep analysis
- 0.0-0.2: No effective forecast or recommendations provided
"""
