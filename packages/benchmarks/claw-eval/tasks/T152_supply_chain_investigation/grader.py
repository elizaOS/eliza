"""T152_supply_chain_investigation grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T151zh_supply_chain_investigation")


class SupplyChainInvestigationGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    _CHAIN_RUBRIC = """\
Evaluate the completeness of the assistant's supply chain problem chain reconstruction (0.0-1.0).

## Complete Chain That Must Be Reconstructed
1. Root cause: Supplier A (Huatong Tech, SUP-1001) was suspended on March 15 due to product quality issues
2. Direct consequence: 4 purchase orders cancelled (TXN-1101 routers, TXN-1102 switches, TXN-1103 firewalls, TXN-1104 fiber optic modules), all cancelled because "supplier shipment suspended"
3. Inventory shortage: ITEM-1101 routers (qty=0), ITEM-1102 switches (qty=3), ITEM-1103 firewalls (qty=0), ITEM-1108 fiber optic modules (qty=2), all below safety stock levels
4. Customer impact: 3 customers paid but orders cannot be shipped
   - CUS-1101 Dingxin Software (VIP): Order #A001, 180K CNY collected
   - CUS-1102 Hanhai E-commerce: Order #A002, 95K CNY collected
   - CUS-1103 Wantong Logistics (VIP): Order #A003, 220K CNY collected
5. Ticket correspondence: TK-1101/1102/1103 correspond to the above 3 customers' complaints

## Distractors That Must Be Excluded
- TK-1104 (software login error) and TK-1105 (invoice correction) are unrelated to the supply chain
- Supplier B (Zhongke Parts) and Supplier C (Tianhe Servers) have normal deliveries

## Strict Scoring
- 0.9-1.0: All 5 steps of the chain fully reconstructed, distractors correctly excluded, causal relationships clear
- 0.7-0.8: Chain is mostly complete but missing 1-2 details (e.g., omitted a product or transaction)
- 0.5-0.6: Identified supplier issue and stock-outs but chain is incomplete (e.g., did not link to specific tickets or customer payments)
- 0.3-0.4: Discovered stock-outs but did not trace back to supplier root cause
- 0.0-0.2: Only browsed partial data, no effective correlation analysis
"""

    _SUPPLIER_RUBRIC = """\
Evaluate the accuracy of the assistant's supplier analysis (0.0-1.0).

## Core Facts That Must Be Discovered
1. Supplier A = Huatong Tech (SUP-1001) is the sole root cause
2. Suspension reason: Product quality issues (router batch return rate exceeded threshold)
3. Suspension date: From March 15
4. Impact scope: This supplier provides 4 products (Smart Router X1, Switch S200, Firewall F500, Fiber Optic Module)
5. All 4 purchases from Supplier A (TXN-1101~1104) were cancelled, totaling 335K CNY
6. Contrast: Purchases from Supplier B and Supplier C (TXN-1105~1107) were all completed normally

## Analysis That Must Be Provided
- Supplier A is the sole source for all 4 out-of-stock products (single-supplier risk)
- Financial/fulfillment risk from 495K CNY collected but unable to ship
- VIP customers (Dingxin Software, Wantong Logistics) affected and need priority handling

## Strict Scoring
- 0.9-1.0: Accurately identified Huatong Tech as root cause + quality issue reason + quantified financial impact + single-supplier risk analysis
- 0.7-0.8: Identified Supplier A as the problem but missing some quantitative data or risk analysis
- 0.5-0.6: Knows supplier has issues but did not fully link all affected products
- 0.3-0.4: Mentioned supplier but analysis lacks depth
- 0.0-0.2: Did not effectively identify supplier root cause
"""

    _RESOLUTION_RUBRIC = """\
Evaluate the quality of the assistant's proposed resolution plan (0.0-1.0).

## Short-Term Emergency Measures (Must Include)
1. Urgently contact Supplier A (Huatong Tech) to understand quality remediation progress and estimated recovery timeline
2. Assess whether temporary sourcing from Supplier B or Supplier C is possible, or find alternative suppliers
3. Prioritize VIP customer orders (CUS-1101 Dingxin Software, CUS-1103 Wantong Logistics)
4. Proactively contact affected customers to explain the situation and provide estimated resolution timeline

## Long-Term Improvement Recommendations (Bonus)
1. Establish a multi-supplier strategy to avoid single-supplier dependency
2. Improve supplier quality monitoring and early warning mechanisms
3. Set up automatic safety stock alerts and restocking triggers
4. Develop a supply chain disruption contingency plan

## Strict Scoring
- 0.9-1.0: All 4 short-term measures included + at least 2 long-term recommendations + measures are specific and actionable
- 0.7-0.8: Short-term plan mostly complete (3-4 items) + has long-term recommendations
- 0.5-0.6: Has resolution ideas but not specific enough, or missing customer communication component
- 0.3-0.4: Only provides vague suggestions
- 0.0-0.2: No effective plan provided
"""
