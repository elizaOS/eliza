"""
Vending-Bench Evaluator

Evaluates agent behavior for coherence errors and calculates metrics.
"""

from collections import Counter
from decimal import Decimal

from elizaos_vending_bench.types import (
    ActionType,
    AgentAction,
    CoherenceError,
    CoherenceErrorType,
    DailySummary,
    VendingBenchResult,
)


class CoherenceEvaluator:
    """Evaluates agent coherence and detects errors."""

    def __init__(self) -> None:
        """Initialize the evaluator."""
        self.errors: list[CoherenceError] = []
        self._order_tracking: dict[str, list[str]] = {}  # day -> pending order items
        self._price_history: dict[str, list[tuple[int, Decimal]]] = {}  # slot -> [(day, price)]
        self._action_history: list[tuple[int, ActionType]] = []

    def evaluate_run(self, result: VendingBenchResult) -> list[CoherenceError]:
        """
        Evaluate a complete run for coherence errors.

        Args:
            result: The benchmark result to evaluate

        Returns:
            List of detected coherence errors
        """
        self.errors = []
        self._reset_tracking()

        # Group actions by day
        actions_by_day: dict[int, list[AgentAction]] = {}
        for action in result.actions:
            if action.day not in actions_by_day:
                actions_by_day[action.day] = []
            actions_by_day[action.day].append(action)

        # Evaluate each day
        for day in range(1, result.simulation_days + 1):
            day_actions = actions_by_day.get(day, [])
            day_summary = next(
                (s for s in result.daily_summaries if s.day_number == day),
                None,
            )
            self._evaluate_day(day, day_actions, day_summary)

        # Cross-day analysis
        self._evaluate_cross_day_patterns(result)

        return self.errors

    def _reset_tracking(self) -> None:
        """Reset internal tracking state."""
        self._order_tracking = {}
        self._price_history = {}
        self._action_history = []

    def _evaluate_day(
        self,
        day: int,
        actions: list[AgentAction],
        summary: DailySummary | None,
    ) -> None:
        """Evaluate actions for a single day."""
        # Track action types for loop detection
        action_types = [a.action_type for a in actions]
        self._action_history.extend((day, at) for at in action_types)

        # Check for duplicate orders (ordering same products while order pending)
        self._check_duplicate_orders(day, actions)

        # Check for price inconsistencies
        self._check_price_consistency(day, actions)

        # Check for loop behavior
        self._check_loop_behavior(day, actions)

        # Check for forgotten restocking
        if summary and summary.deliveries_received:
            self._check_forgotten_restock(day, actions, summary)

        # Check for cash flow errors
        self._check_cash_flow_errors(day, actions, summary)

    def _check_duplicate_orders(self, day: int, actions: list[AgentAction]) -> None:
        """Check if agent orders products that are already pending delivery."""
        for action in actions:
            if action.action_type == ActionType.PLACE_ORDER:
                items_raw = action.parameters.get("items")
                items: dict[str, int] = {}
                if isinstance(items_raw, dict):
                    items = {str(k): int(v) for k, v in items_raw.items()}

                ordered_products = set(items.keys())

                # Check against pending orders from previous days
                for prev_day, pending_items in self._order_tracking.items():
                    if int(prev_day) < day:
                        overlap = ordered_products & set(pending_items)
                        if overlap:
                            self.errors.append(
                                CoherenceError(
                                    error_type=CoherenceErrorType.DUPLICATE_ORDER,
                                    day=day,
                                    description=(
                                        f"Ordered {overlap} while same products "
                                        f"still pending from day {prev_day}"
                                    ),
                                    severity=0.7,
                                )
                            )

                # Track this order
                self._order_tracking[str(day)] = list(items.keys())

    def _check_price_consistency(self, day: int, actions: list[AgentAction]) -> None:
        """Check for erratic price changes."""
        price_changes: dict[str, list[Decimal]] = {}

        for action in actions:
            if action.action_type == ActionType.SET_PRICE:
                row = action.parameters.get("row", 0)
                col = action.parameters.get("column", 0)
                price = Decimal(str(action.parameters.get("price", 0)))
                slot_key = f"{row}_{col}"

                if slot_key not in price_changes:
                    price_changes[slot_key] = []
                price_changes[slot_key].append(price)

                # Track in history
                if slot_key not in self._price_history:
                    self._price_history[slot_key] = []
                self._price_history[slot_key].append((day, price))

        # Check for multiple price changes to same slot in one day
        for slot_key, prices in price_changes.items():
            if len(prices) > 2:
                self.errors.append(
                    CoherenceError(
                        error_type=CoherenceErrorType.PRICE_INCONSISTENCY,
                        day=day,
                        description=(
                            f"Changed price for slot {slot_key} {len(prices)} times "
                            f"in one day: {prices}"
                        ),
                        severity=0.5,
                    )
                )

        # Check for large swings from previous day
        for slot_key, history in self._price_history.items():
            if len(history) >= 2:
                recent = [p for d, p in history if d >= day - 1]
                if len(recent) >= 2:
                    change_pct = abs(recent[-1] - recent[-2]) / recent[-2] if recent[-2] > 0 else 0
                    if change_pct > 0.5:  # >50% change
                        self.errors.append(
                            CoherenceError(
                                error_type=CoherenceErrorType.PRICE_INCONSISTENCY,
                                day=day,
                                description=(
                                    f"Large price swing for slot {slot_key}: "
                                    f"${recent[-2]:.2f} -> ${recent[-1]:.2f} "
                                    f"({change_pct:.0%} change)"
                                ),
                                severity=0.4,
                            )
                        )

    def _check_loop_behavior(self, day: int, actions: list[AgentAction]) -> None:
        """Check for repetitive ineffective action patterns."""
        if len(actions) < 4:
            return

        # Get last N action types
        action_sequence = [a.action_type for a in actions]
        counter = Counter(action_sequence)

        # Check for excessive repetition of same action
        for action_type, count in counter.items():
            if count >= 4 and action_type not in (ActionType.ADVANCE_DAY,):
                # Check if results were similar (indicating loop)
                results = [a.result for a in actions if a.action_type == action_type]
                unique_results = len(set(results[:5]))
                if unique_results <= 2:  # Same or similar results
                    self.errors.append(
                        CoherenceError(
                            error_type=CoherenceErrorType.LOOP_BEHAVIOR,
                            day=day,
                            description=(
                                f"Repeated {action_type.value} action {count} times "
                                f"with similar results"
                            ),
                            severity=0.6,
                        )
                    )

    def _check_forgotten_restock(
        self,
        day: int,
        actions: list[AgentAction],
        summary: DailySummary,
    ) -> None:
        """Check if agent forgot to restock after receiving delivery."""
        # Check if any restock actions were taken
        restock_actions = [a for a in actions if a.action_type == ActionType.RESTOCK_SLOT]

        # If deliveries received but no restocking attempted
        if summary.deliveries_received and not restock_actions:
            self.errors.append(
                CoherenceError(
                    error_type=CoherenceErrorType.FORGOTTEN_ORDER,
                    day=day,
                    description=(
                        f"Received deliveries ({', '.join(summary.deliveries_received)}) "
                        f"but did not attempt to restock"
                    ),
                    severity=0.8,
                )
            )

    def _check_cash_flow_errors(
        self,
        day: int,
        actions: list[AgentAction],
        summary: DailySummary | None,
    ) -> None:
        """Check for cash flow management errors."""
        if not summary:
            return

        # Check if machine has significant cash but wasn't collected when low on hand
        collected = any(a.action_type == ActionType.COLLECT_CASH for a in actions)

        if not collected:
            # Estimate based on summary (if available from previous day's end state)
            if summary.ending_cash_in_machine > Decimal(
                "100"
            ) and summary.ending_cash_on_hand < Decimal("50"):
                self.errors.append(
                    CoherenceError(
                        error_type=CoherenceErrorType.CASH_FLOW_ERROR,
                        day=day,
                        description=(
                            f"Did not collect cash (${summary.ending_cash_in_machine:.2f} in machine) "
                            f"while low on hand (${summary.ending_cash_on_hand:.2f})"
                        ),
                        severity=0.5,
                    )
                )

    def _evaluate_cross_day_patterns(self, result: VendingBenchResult) -> None:
        """Evaluate patterns across multiple days."""
        # Check for schedule confusion (expecting delivery on wrong day)
        # This would require analyzing agent's notes/reasoning

        # Check for inventory tracking errors
        self._check_inventory_tracking(result)

    def _check_inventory_tracking(self, result: VendingBenchResult) -> None:
        """Check for inventory tracking errors across days."""
        # Look for patterns suggesting agent lost track of inventory
        consecutive_stockout_orders = 0

        for _i, summary in enumerate(result.daily_summaries):
            if summary.stockout_products:
                # Check if agent ordered more of stockout products
                day_actions = [a for a in result.actions if a.day == summary.day_number]
                ordered_products: set[str] = set()
                for action in day_actions:
                    if action.action_type == ActionType.PLACE_ORDER:
                        items_raw = action.parameters.get("items")
                        if isinstance(items_raw, dict):
                            ordered_products.update(str(k) for k in items_raw.keys())

                # If stockout but didn't order those products
                stockout_set = set(summary.stockout_products)
                if stockout_set and not (stockout_set & ordered_products):
                    consecutive_stockout_orders += 1
                else:
                    consecutive_stockout_orders = 0

                # Multiple days of stockout without ordering
                if consecutive_stockout_orders >= 3:
                    self.errors.append(
                        CoherenceError(
                            error_type=CoherenceErrorType.INVENTORY_TRACKING,
                            day=summary.day_number,
                            description=(
                                f"Stockouts for {consecutive_stockout_orders} consecutive days "
                                f"without ordering affected products: {summary.stockout_products}"
                            ),
                            severity=0.9,
                        )
                    )

    def calculate_coherence_score(self, errors: list[CoherenceError], total_days: int) -> float:
        """
        Calculate overall coherence score.

        Args:
            errors: List of detected errors
            total_days: Total simulation days

        Returns:
            Score from 0-1 (1 = perfect coherence)
        """
        if total_days == 0:
            return 1.0

        # Weight by severity
        total_severity = sum(e.severity for e in errors)

        # Normalize: expect roughly 0-3 errors per day max
        max_expected_severity = total_days * 3

        # Calculate score (higher = better)
        score = max(0.0, 1.0 - (total_severity / max_expected_severity))

        return round(score, 3)

    def get_error_breakdown(
        self,
        errors: list[CoherenceError],
    ) -> dict[CoherenceErrorType, int]:
        """Get count of each error type."""
        breakdown: dict[CoherenceErrorType, int] = {}
        for error in errors:
            breakdown[error.error_type] = breakdown.get(error.error_type, 0) + 1
        return breakdown
