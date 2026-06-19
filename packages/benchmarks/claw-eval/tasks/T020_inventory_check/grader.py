"""T10en_inventory_check grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T019zh_inventory_check")


class InventoryCheckGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    LOW_STOCK_PRODUCTS = {
        "SKU-004": {"name": "Smart Watch", "aliases": ["Smart Watch S3"],
                     "stock": 0, "threshold": 15, "daily_sales": 3, "lead_time": 10},
        "SKU-001": {"name": "Wireless Bluetooth Earbuds", "aliases": ["Wireless Bluetooth Earbuds Pro"],
                     "stock": 3, "threshold": 20, "daily_sales": 8, "lead_time": 7},
        "SKU-008": {"name": "Ergonomic Mouse", "aliases": [],
                     "stock": 5, "threshold": 20, "daily_sales": 6, "lead_time": 5},
        "SKU-006": {"name": "Mechanical Keyboard", "aliases": ["Mechanical Keyboard Blue Switch"],
                     "stock": 8, "threshold": 25, "daily_sales": 4, "lead_time": 7},
        "SKU-003": {"name": "Laptop Stand", "aliases": [],
                     "stock": 12, "threshold": 30, "daily_sales": 5, "lead_time": 5},
        "SKU-009": {"name": "4K Monitor", "aliases": [],
                     "stock": 50, "threshold": 100, "daily_sales": 15, "lead_time": 14},
        "SKU-010": {"name": "USB-C Hub", "aliases": [],
                     "stock": 0, "threshold": 20, "daily_sales": 8, "lead_time": 7,
                     "status": "backordered", "backorder_eta": "2026-03-10"},
    }

    NON_OBVIOUS_NAMES = ["4K Monitor"]
    BACKORDERED_NAMES = ["USB-C Hub", "USB-C hub", "hub"]

    # ------------------------------------------------------------------ #
    # LLM Judge rubric (English)
    # ------------------------------------------------------------------ #

    _ANALYSIS_RUBRIC = """\
Evaluate the agent's analysis and decision-making quality in the inventory \
management task.
Score each of the three parts separately, then compute a weighted final \
score (0-1).

=== Part 1: Non-Obvious Low-Stock Identification (weight 25%) ===
SKU-009 (4K Monitor) is a non-obvious low-stock item:
- Current stock of 50 looks adequate
- But threshold is 100, daily sales 15, lead time 14 days
- Actually only 3.3 days of stock left, needs 210+ units reorder
- Agent should recognize "stock looks sufficient but actually below safety line"

SKU-010 (USB-C Hub) is a backordered item:
- Current stock 0, status backordered, ETA 2026-03-10 has passed
- Agent should specially flag its backordered status, not treat as simple stockout

Part 1 scoring:
- 0.9-1.0: Clearly noted SKU-009 looks adequate but is actually below safety \
line, and specially addressed SKU-010's backordered status and overdue ETA
- 0.6-0.8: Mentioned both as low-stock but didn't deeply analyze non-obvious features
- 0.3-0.5: Listed products but no special analysis
- 0.0-0.2: Missed SKU-009 or SKU-010

=== Part 2: Urgency Ranking (weight 40%) ===
Correct urgency order (by days of stock remaining):
1. SKU-004 (0 days, out of stock)
2. SKU-010 (0 days, backordered, ETA overdue)
3. SKU-001 (0.4 days)
4. SKU-008 (0.8 days)
5. SKU-006 (2.0 days)
6. SKU-003 (2.4 days)
7. SKU-009 (3.3 days)

Part 2 scoring:
- 0.9-1.0: Correctly ranked all 7 products by remaining days, top 3 most urgent correct
- 0.7-0.8: Top 3 most urgent basically correct, overall order roughly reasonable
- 0.5-0.6: Identified stockout items as most urgent but middle ranking wrong
- 0.3-0.4: Some ranking present but multiple errors
- 0.0-0.2: No urgency ranking

=== Part 3: Reorder Quantity Reasonableness (weight 35%) ===
Reasonable reorder ≈ daily_sales × lead_time + (threshold - current_stock):
- SKU-004: ≈30+15=45
- SKU-001: ≈56+17=73
- SKU-008: ≈30+15=45
- SKU-006: ≈28+17=45
- SKU-003: ≈25+18=43
- SKU-009: ≈210+50=260
- SKU-010: ≈56+20=76 (consider backordered status)

Part 3 scoring:
- 0.9-1.0: Suggested quantities within ±50% of reasonable values
- 0.7-0.8: Most quantities reasonable, a few significantly off
- 0.5-0.6: Gave quantities but most unreasonable (e.g., uniform 50 or too large)
- 0.3-0.4: Suggested restocking but no specific quantities
- 0.0-0.2: No orders placed or reorder quantities suggested

Output the final weighted score: score = 0.25×Part1 + 0.40×Part2 + 0.35×Part3"""
