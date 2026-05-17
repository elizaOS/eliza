"""T120_inventory_cost_analysis grader — English variant of T154zh."""

from __future__ import annotations

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T119zh_inventory_cost_analysis")


class InventoryCostAnalysisGrader(_Base):  # type: ignore[misc]
    """English grader for T155: cross-verify inventory costs against purchase records.

    Inherits scoring logic from T154zh and overrides only Chinese rubric strings.
    """

    _ANOMALY_RUBRIC = """\
Evaluate the assistant's ability to identify cost anomalies (0.0-1.0).

## Anomalies that must be discovered

Anomaly 1 -- Monitor unit price discrepancy (critical):
- ITEM-804 inventory unit_cost = 1500 per unit
- TXN-804 actual purchase amount = 26400 / 12 units = 2200 per unit
- Discrepancy: 700 per unit, 8400 total
- This is a major discrepancy requiring immediate investigation

Anomaly 2 -- Mousepad batch pricing difference (needs attention):
- TXN-806a first batch: 60 units x 8 = 480
- TXN-806b second batch: 40 units x 12 = 480
- Second batch price increased 50% (from 8 to 12)
- ITEM-806 inventory only records unit_cost=8, not reflecting second batch price increase

## Strict scoring
- 0.9-1.0: Both anomalies accurately identified, calculations correct
- 0.6-0.8: Monitor anomaly discovered (the more obvious one)
- 0.3-0.5: Noticed discrepancies but analysis inaccurate
- 0.0-0.2: No anomalies discovered
"""

    _RECONCILIATION_RUBRIC = """\
Evaluate the completeness of the assistant's cost reconciliation across all categories (0.0-1.0).

## Reconciliation results for 6 categories
1. A4 paper: 150 x 25 = 3750 vs TXN-801 (3750) -> consistent
2. Ink cartridge: 20 x 180 = 3600 vs TXN-802 (3600) -> consistent
3. Keyboard: 45 x 350 = 15750 vs TXN-803 (15750) -> consistent
4. Monitor: 12 x 1500 = 18000 vs TXN-804 (26400) -> inconsistent (difference 8400)
5. USB cable: 200 x 15 = 3000 vs TXN-805 (3000) -> consistent
6. Mousepad: 100 x 8 = 800 vs TXN-806a (480) + TXN-806b (480) = 960 -> needs verification

## TXN-807 (rent 85000) should be identified as a non-procurement transaction and excluded

## Strict scoring
- 0.9-1.0: All 6 categories reconciled, non-procurement transaction correctly excluded
- 0.7-0.8: At least 5 categories reconciled
- 0.4-0.6: 3-4 categories reconciled
- 0.0-0.3: Reconciliation seriously incomplete
"""

    _REPORT_RUBRIC = """\
Evaluate the quality of the cost analysis report (0.0-1.0).

## A satisfactory report should include
1. Reconciliation summary table (category / inventory cost / procurement cost / status)
2. Detailed explanation of anomalous items
3. Recommended actions (update inventory unit price, investigate monitor price gap, confirm mousepad price increase reason)
4. Total cost summary

## Strict scoring
- 0.9-1.0: All 4 elements included, data accurate
- 0.6-0.8: 3 elements included
- 0.3-0.5: 1-2 elements included
- 0.0-0.2: No complete report produced
"""
