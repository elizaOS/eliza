"""T132_order_profit_analysis grader — English variant of T166zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T131zh_order_profit_analysis")


class OrderProfitAnalysisGraderEN(_Base):
    """English variant — overrides Chinese rubric strings only."""

    _PROFIT_RUBRIC = """\
Evaluate the accuracy of the assistant's profit margin calculations (0.0-1.0).

## Correct Calculations
CUS-801 Dingxin: cost 43k, selling price 180k, margin 76.1% ((180-43)/180)
CUS-802 Hanhai: cost 20k, selling price 80k, margin 75% ((80-20)/80)
CUS-803 Wantong: cost 50k, selling price 250k, margin 80% ((250-50)/250)
CUS-804 Qianfeng: cost 8k, selling price 30k, margin 73.3% ((30-8)/30)

## Key: Must look up product cost prices
- Cannot only look at selling price and payment differences
- Must get each product's unit_cost from inventory
- Margin = (selling price - cost) / selling price

## Strict Scoring
- 0.9-1.0: All 4 customer margins correct (tolerance +/-2%)
- 0.7-0.8: 3 correct
- 0.4-0.6: 2 correct
- 0.0-0.3: Fewer than 2 or incorrect calculation method
"""

    _PAYMENT_RUBRIC = """\
Evaluate the assistant's identification of payment anomalies (0.0-1.0).

## Must-Discover Anomalies
1. CUS-802 Hanhai E-Commerce: order 80k but only 50k collected (TXN-812), 30k outstanding
   -> Needs follow-up collection or confirmation of installment arrangement

2. CUS-803 Wantong Logistics: full payment 250k (TXN-813) but 20k refund (TXN-814)
   -> Net collected 230k, refund reason is "implementation delay compensation"
   -> Actual profit = 230k - 50k = 180k (not 200k)

## Non-Anomalies
- CUS-801 fully collected [OK]
- CUS-804 fully collected [OK]
- TXN-816 payroll is a non-order transaction, should be excluded

## Strict Scoring
- 0.9-1.0: Both anomalies accurately identified with impact analysis
- 0.6-0.8: 1 anomaly identified
- 0.3-0.5: Noticed issues but inaccurate analysis
- 0.0-0.2: No anomalies discovered
"""

    _REPORT_RUBRIC = """\
Evaluate the structure and insight quality of the report (0.0-1.0).

## Acceptable Report Should Include
1. Per-customer profit margin comparison table
2. Payment status annotations
3. Anomaly explanations and recommendations
4. Overall profit summary
5. Insights (e.g.: Wantong has highest margin, Hanhai has bad debt risk)

## Strict Scoring
- 0.9-1.0: All 5 elements included
- 0.6-0.8: 3-4 elements included
- 0.3-0.5: 1-2 elements included
- 0.0-0.2: No structured report
"""
