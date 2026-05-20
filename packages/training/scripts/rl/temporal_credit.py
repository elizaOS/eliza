"""
Temporal Credit Assignment for Delayed Rewards

When an agent makes a trading decision, the actual outcome (P&L) may not be
known until later - when the position is closed, the market resolves, or the
trading window ends. This module handles assigning credit back to the
decisions that caused eventual outcomes.

Key concepts:
- Decision: A trade action (buy, sell, open position, close position)
- Outcome: The eventual P&L realization
- Credit: Weight assigned to a decision based on temporal distance from outcome
- Decay: Credit weight decreases exponentially with distance from outcome

This implements a form of temporal difference credit assignment common in RL,
adapted for the trading domain where outcomes are delayed.
"""

from collections import defaultdict

from .rewards import TEMPORAL_CREDIT_DECAY, TemporalCredit

# =============================================================================
# Configuration
# =============================================================================

# Action types considered as trading decisions for credit assignment
TRADING_ACTION_TYPES = frozenset(
    [
        "buy",
        "sell",
        "buy_prediction",
        "sell_prediction",
        "open_perp",
        "close_perp",
        "open_long",
        "open_short",
        "close_long",
        "close_short",
        "trade",
        "trading",
    ]
)

# Default decay rate (can be overridden)
DEFAULT_DECAY_RATE = TEMPORAL_CREDIT_DECAY  # 0.9


# =============================================================================
# Core Functions
# =============================================================================


def is_trading_action(action_type: str) -> bool:
    """
    Check if an action type is a trading decision.

    Args:
        action_type: Action type string from trajectory step

    Returns:
        True if this is a trading action that should receive credit
    """
    normalized = action_type.lower().strip()
    return normalized in TRADING_ACTION_TYPES or any(
        t in normalized for t in ("buy", "sell", "trade", "open", "close")
    )


def extract_market_id(step: dict) -> str | None:
    """
    Extract market identifier from a trajectory step.

    Checks multiple possible parameter names for the market/ticker.

    Args:
        step: Trajectory step dictionary

    Returns:
        Market ID string if found, None otherwise
    """
    action = step.get("action", {})
    params = action.get("parameters", {})

    # Check common parameter names
    for key in ("marketId", "market_id", "ticker", "market", "symbol"):
        value = params.get(key)
        if value:
            return str(value)

    # Check result for market info
    result = action.get("result", {})
    for key in ("market", "ticker", "marketId"):
        value = result.get(key)
        if value:
            return str(value)

    return None


def extract_action_pnl(step: dict) -> float | None:
    """
    Extract P&L from a trajectory step if available.

    Some actions (especially closes) have immediate P&L in the result.

    Args:
        step: Trajectory step dictionary

    Returns:
        P&L value if present, None otherwise
    """
    action = step.get("action", {})
    result = action.get("result", {})

    # Check for P&L in result
    pnl = result.get("pnl")
    if pnl is not None:
        return float(pnl)

    # Check for realized P&L
    realized = result.get("realizedPnL") or result.get("realized_pnl")
    if realized is not None:
        return float(realized)

    return None


def calculate_credit_weight(
    decision_step: int,
    outcome_step: int,
    decay_rate: float = DEFAULT_DECAY_RATE,
) -> float:
    """
    Calculate credit weight based on temporal distance.

    Uses exponential decay: weight = decay_rate ^ (distance)

    The idea is that decisions closer to the outcome should receive more
    credit, while distant decisions receive less (but still some).

    Args:
        decision_step: Step index where decision was made
        outcome_step: Step index where outcome was observed
        decay_rate: Decay rate per step (default 0.9)

    Returns:
        Credit weight in (0, 1]
    """
    distance = max(0, outcome_step - decision_step)
    return decay_rate**distance


def attribute_temporal_credit(
    steps: list[dict],
    final_pnl: float,
    outcome_data: dict[str, float] | None = None,
    decay_rate: float = DEFAULT_DECAY_RATE,
) -> list[TemporalCredit]:
    """
    Assign credit to trading decisions based on eventual outcomes.

    This is the main entry point for temporal credit assignment. It:
    1. Identifies trading decisions in the trajectory
    2. Matches them to outcomes (per-market or overall)
    3. Assigns credit weights based on temporal distance

    Credit assignment strategies:
    - If outcome_data has per-market P&L, use that for specific trades
    - Otherwise, distribute final_pnl across all trading decisions

    Args:
        steps: List of trajectory step dictionaries
        final_pnl: Final P&L for the entire trajectory
        outcome_data: Optional dict mapping market_id to P&L
                     Example: {"BTC": 150.0, "ETH": -50.0}
        decay_rate: Decay rate for credit weighting

    Returns:
        List of TemporalCredit assignments
    """
    if not steps:
        return []

    credits: list[TemporalCredit] = []

    # Collect all trading decisions with their indices
    trading_decisions: list[tuple[int, str, dict]] = []  # (step_idx, market_id, step)

    for i, step in enumerate(steps):
        action = step.get("action", {})
        action_type = action.get("actionType", action.get("action_type", ""))

        if is_trading_action(action_type):
            market_id = extract_market_id(step)
            if market_id:
                trading_decisions.append((i, market_id, step))

    if not trading_decisions:
        return []

    # Group decisions by market for per-market credit assignment
    decisions_by_market: dict[str, list[tuple[int, dict]]] = defaultdict(list)
    for step_idx, market_id, step in trading_decisions:
        decisions_by_market[market_id].append((step_idx, step))

    outcome_step = len(steps) - 1  # Assume outcome at end of trajectory

    # Assign credit based on available outcome data
    if outcome_data:
        # Per-market credit assignment
        for market_id, market_pnl in outcome_data.items():
            market_decisions = decisions_by_market.get(market_id, [])

            if not market_decisions:
                continue

            # Distribute P&L across decisions for this market
            # Weight by temporal proximity to outcome
            total_weight = sum(
                calculate_credit_weight(idx, outcome_step, decay_rate)
                for idx, _ in market_decisions
            )

            for step_idx, step in market_decisions:
                weight = calculate_credit_weight(step_idx, outcome_step, decay_rate)

                # Normalize weight to distribute P&L proportionally
                normalized_weight = weight / total_weight if total_weight > 0 else 0
                credited_pnl = market_pnl * normalized_weight

                credits.append(
                    TemporalCredit(
                        decision_step=step_idx,
                        outcome_step=outcome_step,
                        credit_weight=weight,
                        outcome_pnl=credited_pnl,
                        market_id=market_id,
                    )
                )
    else:
        # No per-market data, distribute final_pnl across all decisions
        all_decisions = [(idx, market, step) for idx, market, step in trading_decisions]

        # Calculate total weight for normalization
        total_weight = sum(
            calculate_credit_weight(idx, outcome_step, decay_rate) for idx, _, _ in all_decisions
        )

        for step_idx, market_id, step in all_decisions:
            weight = calculate_credit_weight(step_idx, outcome_step, decay_rate)

            # Distribute final P&L proportionally by weight
            normalized_weight = weight / total_weight if total_weight > 0 else 0
            credited_pnl = final_pnl * normalized_weight

            credits.append(
                TemporalCredit(
                    decision_step=step_idx,
                    outcome_step=outcome_step,
                    credit_weight=weight,
                    outcome_pnl=credited_pnl,
                    market_id=market_id,
                )
            )

    return credits


def attribute_credit_with_intermediate_outcomes(
    steps: list[dict],
    decay_rate: float = DEFAULT_DECAY_RATE,
) -> list[TemporalCredit]:
    """
    Assign credit using intermediate outcomes from step results.

    Some steps have immediate P&L (e.g., closing a position). This function
    uses those intermediate outcomes for more accurate credit assignment.

    Args:
        steps: List of trajectory step dictionaries
        decay_rate: Decay rate for credit weighting

    Returns:
        List of TemporalCredit assignments
    """
    credits: list[TemporalCredit] = []

    # Track open positions and their opening step
    open_positions: dict[str, list[int]] = defaultdict(list)

    for i, step in enumerate(steps):
        action = step.get("action", {})
        action_type = action.get("actionType", action.get("action_type", "")).lower()
        market_id = extract_market_id(step)

        if not market_id:
            continue

        # Track opening positions
        if any(t in action_type for t in ("buy", "open", "long")):
            open_positions[market_id].append(i)

        # Process closing positions with P&L
        elif any(t in action_type for t in ("sell", "close")):
            pnl = extract_action_pnl(step)

            if pnl is not None:
                # Find opening decisions to credit
                opening_steps = open_positions.get(market_id, [])

                if opening_steps:
                    # Credit to most recent opening (LIFO)
                    opening_step = opening_steps.pop()
                    weight = calculate_credit_weight(opening_step, i, decay_rate)

                    credits.append(
                        TemporalCredit(
                            decision_step=opening_step,
                            outcome_step=i,
                            credit_weight=weight,
                            outcome_pnl=pnl * weight,
                            market_id=market_id,
                        )
                    )

                # Also credit the closing decision (it realized the P&L)
                credits.append(
                    TemporalCredit(
                        decision_step=i,
                        outcome_step=i,
                        credit_weight=1.0,
                        outcome_pnl=pnl,
                        market_id=market_id,
                    )
                )

    return credits


def aggregate_credits_by_step(credits: list[TemporalCredit]) -> dict[int, float]:
    """Aggregate temporal credits by decision step."""
    aggregated: dict[int, float] = defaultdict(float)
    for credit in credits:
        aggregated[credit.decision_step] += credit.outcome_pnl
    return dict(aggregated)


def aggregate_credits_by_market(credits: list[TemporalCredit]) -> dict[str, float]:
    """Aggregate temporal credits by market."""
    aggregated: dict[str, float] = defaultdict(float)
    for credit in credits:
        aggregated[credit.market_id or "unknown"] += credit.outcome_pnl
    return dict(aggregated)
