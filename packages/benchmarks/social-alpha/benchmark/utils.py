"""Shared utilities for the benchmark suites."""

from __future__ import annotations

import math
from typing import Literal

from .protocol import SocialAlphaSystem


def safe_float(val: float) -> float:
    """Clamp NaN/inf to 0.0. Used to guard scipy/numpy statistical outputs."""
    if math.isnan(val) or math.isinf(val):
        return 0.0
    return val


def replay_calls(
    system: SocialAlphaSystem,
    call_ground_truth: list[dict],
    include_prices: bool = True,
) -> None:
    """
    Replay calls and price updates through a system in chronological order.

    This is the SINGLE canonical replay function used by all suites (RANK,
    DETECT, PROFIT) to ensure consistent data presentation.

    Args:
        system: System under test
        call_ground_truth: Ground truth call records
        include_prices: Whether to also feed price updates (best/worst)
    """
    sorted_calls = sorted(call_ground_truth, key=lambda c: c["timestamp"])

    for call in sorted_calls:
        # Only replay actual recommendations (BUY/SELL), not NOISE
        if call.get("is_recommendation") and call.get("recommendation_type") != "NOISE":
            system.process_call(
                user_id=call["user_id"],
                token_address=call["token_address"],
                recommendation_type=call["recommendation_type"],
                conviction=call["conviction"],
                price_at_call=call["price_at_call"],
                timestamp=call["timestamp"],
            )

        # Feed price updates for ALL calls with price data (consistent across suites)
        if include_prices:
            if call.get("token_address") and call.get("worst_price"):
                system.update_price(
                    call["token_address"],
                    call["worst_price"],
                    call["timestamp"] + 43200000,  # +12h
                )
            if call.get("token_address") and call.get("best_price"):
                system.update_price(
                    call["token_address"],
                    call["best_price"],
                    call["timestamp"] + 86400000,  # +24h
                )
