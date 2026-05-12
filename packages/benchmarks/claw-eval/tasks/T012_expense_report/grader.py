"""T06en_expense_report grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T011zh_expense_report")


class ExpenseReportGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    CATEGORY_ALIASES = {
        "餐饮": ["meals", "dining", "food", "coffee", "dinner", "restaurant", "lunch"],
        "差旅": ["travel", "transport", "accommodation", "hotel", "flight", "taxi", "ride", "business trip"],
        "IT": ["IT", "equipment", "keyboard", "monitor", "electronics", "hardware", "device"],
        "办公": ["office", "stationery", "supplies"],
        "云服务": ["cloud", "server", "hosting", "infrastructure"],
        "退款": ["refund", "credit", "negative", "cancelled", "reimbursement"],
    }

    # ------------------------------------------------------------------ #
    # LLM Judge rubrics (English)
    # ------------------------------------------------------------------ #

    _CATEGORIZATION_RUBRIC = """\
Evaluate the agent's categorization accuracy for the 13 transactions.

Correct categorizations:
- Dining/Meals: txn_001 (coffee), txn_005 (food delivery), txn_009 (business dinner)
- Travel: txn_002 (taxi), txn_003 (taxi), txn_006 (flight), txn_007 (hotel), \
txn_011 (taxi)
- IT Equipment: txn_004 (keyboard), txn_013 (monitor)
- Office Supplies: txn_008 (stationery)
- Cloud Services: txn_010 (server)
- Refund: txn_012 (refund, negative amount)

Scoring:
- 0.9-1.0: All or nearly all transactions correctly categorized, reasonable \
category system
- 0.7-0.8: Most categorized correctly, minor errors or slightly different but \
reasonable categories
- 0.4-0.6: Some correct but significant errors or omissions
- 0.1-0.3: Few correct or chaotic categorization
- 0.0: No categorization at all"""

    _ANOMALY_DETECTION_RUBRIC = """\
Evaluate the agent's ability to identify and handle anomalous transactions.

Three types of anomalies to identify:

1. Exact duplicate: txn_002 and txn_003
   - Same date, same merchant (Didi/ride-hailing), same amount (¥45)
   - Should be flagged as duplicate, one excluded from submission

2. Near-duplicate: txn_011
   - Similar to txn_002/003 (also ride-hailing), but amount is ¥44.99 \
(differs by ¥0.01)
   - Should note the difference — likely a legitimate return trip, should \
not auto-merge

3. Refund transaction: txn_012
   - Amount is -¥328 (negative)
   - Should be identified as a refund/credit, not a regular expense

Scoring:
- 0.9-1.0: All three anomaly types correctly identified and properly handled
- 0.7-0.8: Identified duplicates and refund, but near-duplicate handling unclear
- 0.4-0.6: Only identified one or two anomaly types
- 0.1-0.3: Briefly mentioned but no substantive analysis
- 0.0: No anomalous transactions identified"""
