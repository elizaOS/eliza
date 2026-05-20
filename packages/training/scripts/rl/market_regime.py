"""
Market Regime Detection for Enhanced Reward Signals

Detects market conditions (bull/bear/sideways) from price data to provide
context-aware reward signals. This enables the training system to distinguish
between skill and luck - a profitable trade in a crashing market is more
impressive than one in a bull run.

Key concepts:
- Regime: Overall market direction (bull/bear/sideways)
- Volatility: Price variance, used to dampen reward signals in noisy markets
- Per-ticker trends: Individual asset movements for granular analysis
"""

import logging
import math
from dataclasses import dataclass
from typing import Any, Literal, Union

logger = logging.getLogger(__name__)


# =============================================================================
# Regime Detection Thresholds
# =============================================================================

# Overall regime thresholds (percentage change)
BULL_THRESHOLD = 5.0  # >5% avg increase = bull market
BEAR_THRESHOLD = -5.0  # <-5% avg decrease = bear market

# Per-ticker trend thresholds
TICKER_UP_THRESHOLD = 5.0
TICKER_DOWN_THRESHOLD = -5.0

# Volatility normalization (expected std dev range)
VOLATILITY_LOW = 2.0  # Low volatility market
VOLATILITY_HIGH = 15.0  # High volatility market

# Regime-based expected returns for counterfactual calculation
REGIME_EXPECTED_RETURNS: dict[str, float] = {
    "bull": 0.05,  # Expect +5% return in bull market
    "bear": -0.05,  # Expect -5% loss in bear market
    "sideways": 0.0,  # Expect flat in sideways market
}


# =============================================================================
# Data Structures
# =============================================================================


@dataclass
class MarketRegime:
    """
    Market condition during a trajectory's time window.

    Attributes:
        overall: Aggregate market direction across all tracked assets
        volatility: Normalized volatility score (0.0 = calm, 1.0 = extreme)
        per_ticker: Individual asset trends for granular analysis
        avg_change_pct: Average percentage change across all tickers
        window_id: Time window this regime applies to (for caching)
    """

    overall: Literal["bull", "bear", "sideways"]
    volatility: float
    per_ticker: dict[str, Literal["up", "down", "flat"]]
    avg_change_pct: float = 0.0
    window_id: str | None = None

    def to_dict(self) -> dict:
        """Serialize for logging/storage."""
        return {
            "overall": self.overall,
            "volatility": self.volatility,
            "per_ticker": self.per_ticker,
            "avg_change_pct": self.avg_change_pct,
            "window_id": self.window_id,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "MarketRegime":
        """Deserialize from storage."""
        return cls(
            overall=data["overall"],
            volatility=data["volatility"],
            per_ticker=data.get("per_ticker", {}),
            avg_change_pct=data.get("avg_change_pct", 0.0),
            window_id=data.get("window_id"),
        )

    @classmethod
    def default_sideways(cls) -> "MarketRegime":
        """Create a neutral/unknown regime for fallback."""
        return cls(
            overall="sideways",
            volatility=0.5,
            per_ticker={},
            avg_change_pct=0.0,
            window_id=None,
        )


# =============================================================================
# Regime Detection Functions
# =============================================================================


def calculate_volatility(changes: list[float]) -> float:
    """
    Calculate normalized volatility from a list of percentage changes.

    Uses standard deviation normalized to [0, 1] range based on expected
    market volatility bounds.

    Args:
        changes: List of percentage changes (e.g., [2.5, -1.0, 3.2])

    Returns:
        Volatility score in [0, 1] range
    """
    if len(changes) < 2:
        return 0.5  # Default to moderate volatility with insufficient data

    # Calculate mean
    mean = sum(changes) / len(changes)

    # Calculate variance
    variance = sum((x - mean) ** 2 for x in changes) / len(changes)

    # Standard deviation
    std_dev = math.sqrt(variance)

    # Normalize to [0, 1] based on expected volatility range
    normalized = (std_dev - VOLATILITY_LOW) / (VOLATILITY_HIGH - VOLATILITY_LOW)

    return max(0.0, min(1.0, normalized))


def calculate_price_change_pct(initial: float, final: float) -> float:
    """
    Calculate percentage change between two prices.

    Args:
        initial: Starting price
        final: Ending price

    Returns:
        Percentage change (e.g., 5.0 for +5%)
    """
    if initial <= 0:
        logger.debug(
            "Invalid initial price for pct change calculation (initial=%s, final=%s)",
            initial,
            final,
        )
        return 0.0
    return ((final - initial) / initial) * 100


def detect_ticker_trend(change_pct: float) -> Literal["up", "down", "flat"]:
    """
    Classify a single ticker's trend based on percentage change.

    Args:
        change_pct: Percentage change for the ticker

    Returns:
        Trend classification
    """
    if change_pct > TICKER_UP_THRESHOLD:
        return "up"
    elif change_pct < TICKER_DOWN_THRESHOLD:
        return "down"
    return "flat"


def detect_overall_regime(avg_change: float) -> Literal["bull", "bear", "sideways"]:
    """
    Classify overall market regime based on average change.

    Args:
        avg_change: Average percentage change across all tickers

    Returns:
        Regime classification
    """
    if avg_change > BULL_THRESHOLD:
        return "bull"
    elif avg_change < BEAR_THRESHOLD:
        return "bear"
    return "sideways"


def detect_market_regime(
    price_data: dict[str, list[float]],
    window_id: str | None = None,
) -> MarketRegime:
    """
    Detect market regime from price history data.

    This is the main entry point for regime detection. It analyzes price
    movements across multiple tickers to determine:
    1. Overall market direction (bull/bear/sideways)
    2. Market volatility
    3. Per-ticker trends

    Args:
        price_data: Dictionary mapping ticker symbols to price history lists.
                   Each list should be chronologically ordered (oldest first).
                   Example: {"BTC": [100000, 105000, 110000], "ETH": [4000, 3900, 4100]}
        window_id: Optional time window identifier for caching

    Returns:
        MarketRegime with overall trend, volatility, and per-ticker breakdowns
    """
    if not price_data:
        return MarketRegime.default_sideways()

    per_ticker: dict[str, Literal["up", "down", "flat"]] = {}
    changes: list[float] = []

    for ticker, prices in price_data.items():
        if len(prices) < 2:
            per_ticker[ticker] = "flat"
            continue

        # Calculate change from first to last price
        initial_price = prices[0]
        final_price = prices[-1]
        change_pct = calculate_price_change_pct(initial_price, final_price)

        changes.append(change_pct)
        per_ticker[ticker] = detect_ticker_trend(change_pct)

    # Calculate aggregate metrics
    if not changes:
        return MarketRegime(
            overall="sideways",
            volatility=0.5,
            per_ticker=per_ticker,
            avg_change_pct=0.0,
            window_id=window_id,
        )

    avg_change = sum(changes) / len(changes)
    volatility = calculate_volatility(changes)
    overall = detect_overall_regime(avg_change)

    return MarketRegime(
        overall=overall,
        volatility=volatility,
        per_ticker=per_ticker,
        avg_change_pct=avg_change,
        window_id=window_id,
    )


# Price value can be a float or a dict with price key (from different data sources)
PriceValue = Union[float, int, dict[str, Any]]


def detect_regime_from_prices(
    initial_prices: dict[str, PriceValue],
    final_prices: dict[str, PriceValue],
    window_id: str | None = None,
) -> MarketRegime:
    """
    Detect market regime from initial/final price snapshots.

    Convenience function when only start/end prices are available
    (no full history). This is common for trajectory metadata.

    Args:
        initial_prices: Prices at start of window {"BTC": 100000, "ETH": 4000}
        final_prices: Prices at end of window {"BTC": 110000, "ETH": 3800}
        window_id: Optional time window identifier

    Returns:
        MarketRegime based on start-to-end changes
    """
    # Convert to price_data format (2-element lists)
    price_data: dict[str, list[float]] = {}

    all_tickers = set(initial_prices.keys()) | set(final_prices.keys())

    for ticker in all_tickers:
        initial_val = initial_prices.get(ticker, 0.0)
        final_val = final_prices.get(ticker, initial_val)

        # Handle both formats:
        # - Simple: {"BTC": 100000}
        # - Complex: {"BTC": {"tick": 0, "price": 100000}}
        if isinstance(initial_val, dict):
            initial_val = initial_val.get("price", 0.0)
        if isinstance(final_val, dict):
            final_val = final_val.get("price", initial_val)

        # Ensure numeric
        try:
            initial_val = float(initial_val)
            final_val = float(final_val)
        except (TypeError, ValueError):
            continue

        if initial_val > 0:
            price_data[ticker] = [initial_val, final_val]

    return detect_market_regime(price_data, window_id)


def extract_regime_from_trajectory(trajectory: dict) -> MarketRegime | None:
    """
    Extract market regime from trajectory metadata if available.

    Trajectories generated with enhanced metadata will include price context.
    This function extracts or computes the regime from that context.

    Args:
        trajectory: Trajectory dictionary with optional metadata.price_context

    Returns:
        MarketRegime if extractable, None otherwise
    """
    metadata = trajectory.get("metadata", {})

    # Check for pre-computed regime
    price_context = metadata.get("price_context", {})
    if price_context:
        regime_data = price_context.get("regime")
        if regime_data:
            return MarketRegime.from_dict(regime_data)

        # Compute from price snapshots if available
        initial_prices = price_context.get("initial_prices", {})
        final_prices = price_context.get("final_prices", {})

        if initial_prices and final_prices:
            return detect_regime_from_prices(
                initial_prices,
                final_prices,
                trajectory.get("window_id"),
            )

    # Check for legacy ground_truth format (from causal simulation)
    ground_truth = metadata.get("ground_truth", {})
    if ground_truth:
        initial_prices = ground_truth.get("initialPrices", {})
        final_prices = ground_truth.get("finalPrices", {})

        if initial_prices and final_prices:
            return detect_regime_from_prices(
                initial_prices,
                final_prices,
                trajectory.get("window_id"),
            )

    return None


def get_expected_return(regime: MarketRegime) -> float:
    """
    Get expected return for a market regime (for counterfactual calculation).

    Args:
        regime: Market regime

    Returns:
        Expected return as decimal (e.g., 0.05 for +5%)
    """
    return REGIME_EXPECTED_RETURNS.get(regime.overall, 0.0)
