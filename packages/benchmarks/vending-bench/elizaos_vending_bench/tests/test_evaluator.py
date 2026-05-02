"""Tests for Vending-Bench coherence evaluator."""

from decimal import Decimal

from elizaos_vending_bench.evaluator import CoherenceEvaluator
from elizaos_vending_bench.types import (
    ActionType,
    AgentAction,
    CoherenceErrorType,
    DailySummary,
    Season,
    VendingBenchResult,
    WeatherCondition,
)


class TestCoherenceEvaluator:
    """Test CoherenceEvaluator class."""

    def test_create_evaluator(self) -> None:
        """Test creating an evaluator."""
        evaluator = CoherenceEvaluator()
        assert evaluator.errors == []

    def test_evaluate_empty_run(self) -> None:
        """Test evaluating a run with no actions."""
        evaluator = CoherenceEvaluator()
        result = VendingBenchResult(
            run_id="test",
            simulation_days=0,
            final_net_worth=Decimal("500"),
            initial_cash=Decimal("500"),
            profit=Decimal("0"),
            total_revenue=Decimal("0"),
            total_costs=Decimal("0"),
            total_operational_fees=Decimal("0"),
            items_sold=0,
            orders_placed=0,
            successful_deliveries=0,
            stockout_days=0,
        )

        errors = evaluator.evaluate_run(result)
        assert errors == []

    def test_detect_duplicate_order(self) -> None:
        """Test detecting duplicate orders."""
        evaluator = CoherenceEvaluator()

        # Create actions with duplicate orders
        actions = [
            AgentAction(
                action_type=ActionType.PLACE_ORDER,
                day=1,
                parameters={"supplier_id": "beverage_dist", "items": {"water": 12}},
                result="Order placed",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.ADVANCE_DAY,
                day=1,
                parameters={},
                result="Day completed",
                success=True,
            ),
            # Same product ordered next day while first order still pending
            AgentAction(
                action_type=ActionType.PLACE_ORDER,
                day=2,
                parameters={"supplier_id": "beverage_dist", "items": {"water": 12}},
                result="Order placed",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.ADVANCE_DAY,
                day=2,
                parameters={},
                result="Day completed",
                success=True,
            ),
        ]

        result = VendingBenchResult(
            run_id="test",
            simulation_days=2,
            final_net_worth=Decimal("450"),
            initial_cash=Decimal("500"),
            profit=Decimal("-50"),
            total_revenue=Decimal("0"),
            total_costs=Decimal("50"),
            total_operational_fees=Decimal("22"),
            items_sold=0,
            orders_placed=2,
            successful_deliveries=0,
            stockout_days=0,
            actions=actions,
            daily_summaries=[],
        )

        errors = evaluator.evaluate_run(result)

        # Should detect duplicate order
        duplicate_errors = [e for e in errors if e.error_type == CoherenceErrorType.DUPLICATE_ORDER]
        assert len(duplicate_errors) >= 1

    def test_detect_price_inconsistency(self) -> None:
        """Test detecting erratic price changes."""
        evaluator = CoherenceEvaluator()

        # Multiple price changes to same slot in one day
        actions = [
            AgentAction(
                action_type=ActionType.SET_PRICE,
                day=1,
                parameters={"row": 0, "column": 0, "price": 1.50},
                result="Price set",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.SET_PRICE,
                day=1,
                parameters={"row": 0, "column": 0, "price": 2.00},
                result="Price set",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.SET_PRICE,
                day=1,
                parameters={"row": 0, "column": 0, "price": 1.00},
                result="Price set",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.ADVANCE_DAY,
                day=1,
                parameters={},
                result="Day completed",
                success=True,
            ),
        ]

        result = VendingBenchResult(
            run_id="test",
            simulation_days=1,
            final_net_worth=Decimal("489"),
            initial_cash=Decimal("500"),
            profit=Decimal("-11"),
            total_revenue=Decimal("0"),
            total_costs=Decimal("0"),
            total_operational_fees=Decimal("11"),
            items_sold=0,
            orders_placed=0,
            successful_deliveries=0,
            stockout_days=0,
            actions=actions,
            daily_summaries=[],
        )

        errors = evaluator.evaluate_run(result)

        # Should detect price inconsistency
        price_errors = [e for e in errors if e.error_type == CoherenceErrorType.PRICE_INCONSISTENCY]
        assert len(price_errors) >= 1

    def test_detect_loop_behavior(self) -> None:
        """Test detecting repetitive loop behavior."""
        evaluator = CoherenceEvaluator()

        # Repeated same action with same result
        actions = [
            AgentAction(
                action_type=ActionType.VIEW_STATE,
                day=1,
                parameters={},
                result="Business State: ...",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.VIEW_STATE,
                day=1,
                parameters={},
                result="Business State: ...",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.VIEW_STATE,
                day=1,
                parameters={},
                result="Business State: ...",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.VIEW_STATE,
                day=1,
                parameters={},
                result="Business State: ...",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.ADVANCE_DAY,
                day=1,
                parameters={},
                result="Day completed",
                success=True,
            ),
        ]

        result = VendingBenchResult(
            run_id="test",
            simulation_days=1,
            final_net_worth=Decimal("489"),
            initial_cash=Decimal("500"),
            profit=Decimal("-11"),
            total_revenue=Decimal("0"),
            total_costs=Decimal("0"),
            total_operational_fees=Decimal("11"),
            items_sold=0,
            orders_placed=0,
            successful_deliveries=0,
            stockout_days=0,
            actions=actions,
            daily_summaries=[],
        )

        errors = evaluator.evaluate_run(result)

        # Should detect loop behavior
        loop_errors = [e for e in errors if e.error_type == CoherenceErrorType.LOOP_BEHAVIOR]
        assert len(loop_errors) >= 1

    def test_detect_forgotten_restock(self) -> None:
        """Test detecting forgotten restocking after delivery."""
        evaluator = CoherenceEvaluator()

        # Actions without restocking after delivery
        actions = [
            AgentAction(
                action_type=ActionType.CHECK_DELIVERIES,
                day=3,
                parameters={},
                result="Delivery received",
                success=True,
            ),
            AgentAction(
                action_type=ActionType.ADVANCE_DAY,
                day=3,
                parameters={},
                result="Day completed",
                success=True,
            ),
        ]

        summary = DailySummary(
            day_number=3,
            sim_date=None,  # type: ignore
            weather=WeatherCondition.SUNNY,
            season=Season.SUMMER,
            total_revenue=Decimal("0"),
            operational_fees=Decimal("11"),
            ending_cash_on_hand=Decimal("400"),
            ending_cash_in_machine=Decimal("0"),
            ending_inventory_value=Decimal("0"),
            net_worth=Decimal("400"),
            deliveries_received=["ORD-0001"],  # Delivery received
        )

        result = VendingBenchResult(
            run_id="test",
            simulation_days=3,
            final_net_worth=Decimal("400"),
            initial_cash=Decimal("500"),
            profit=Decimal("-100"),
            total_revenue=Decimal("0"),
            total_costs=Decimal("50"),
            total_operational_fees=Decimal("33"),
            items_sold=0,
            orders_placed=1,
            successful_deliveries=1,
            stockout_days=0,
            actions=actions,
            daily_summaries=[summary],
        )

        errors = evaluator.evaluate_run(result)

        # Should detect forgotten restocking
        forgotten_errors = [e for e in errors if e.error_type == CoherenceErrorType.FORGOTTEN_ORDER]
        assert len(forgotten_errors) >= 1

    def test_coherence_score_perfect(self) -> None:
        """Test coherence score calculation with no errors."""
        evaluator = CoherenceEvaluator()

        score = evaluator.calculate_coherence_score([], total_days=30)
        assert score == 1.0

    def test_coherence_score_with_errors(self) -> None:
        """Test coherence score calculation with errors."""
        evaluator = CoherenceEvaluator()

        from elizaos_vending_bench.types import CoherenceError

        errors = [
            CoherenceError(
                error_type=CoherenceErrorType.DUPLICATE_ORDER,
                day=1,
                description="Test error",
                severity=1.0,
            ),
            CoherenceError(
                error_type=CoherenceErrorType.PRICE_INCONSISTENCY,
                day=2,
                description="Test error",
                severity=0.5,
            ),
        ]

        score = evaluator.calculate_coherence_score(errors, total_days=10)
        # Score should be between 0 and 1
        assert 0 <= score <= 1
        # With some errors, score should be less than 1
        assert score < 1.0

    def test_get_error_breakdown(self) -> None:
        """Test error breakdown by type."""
        evaluator = CoherenceEvaluator()

        from elizaos_vending_bench.types import CoherenceError

        errors = [
            CoherenceError(CoherenceErrorType.DUPLICATE_ORDER, 1, "Error 1"),
            CoherenceError(CoherenceErrorType.DUPLICATE_ORDER, 2, "Error 2"),
            CoherenceError(CoherenceErrorType.PRICE_INCONSISTENCY, 3, "Error 3"),
        ]

        breakdown = evaluator.get_error_breakdown(errors)

        assert breakdown[CoherenceErrorType.DUPLICATE_ORDER] == 2
        assert breakdown[CoherenceErrorType.PRICE_INCONSISTENCY] == 1
