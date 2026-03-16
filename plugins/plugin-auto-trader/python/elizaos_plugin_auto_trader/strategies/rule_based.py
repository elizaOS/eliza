from __future__ import annotations

from elizaos_plugin_auto_trader.types import MarketData, TradeSignal


def _moving_average(prices: list[float], window: int) -> float | None:
    if len(prices) < window or window == 0:
        return None
    s = prices[-window:]
    return sum(s) / len(s)


class RuleBasedStrategy:
    """Simple moving-average crossover strategy (simulated).

    Uses a short and long window over the price history to detect crossovers.
    Short MA above long MA → buy signal.
    Short MA below long MA → sell signal.
    """

    def __init__(self, short_window: int = 5, long_window: int = 20) -> None:
        self.short_window = max(1, short_window)
        self.long_window = max(2, long_window)

    @property
    def name(self) -> str:
        return "RuleBased"

    async def analyze(self, market_data: MarketData) -> TradeSignal | None:
        prices = market_data.prices
        if len(prices) < self.long_window:
            return None

        short_ma = _moving_average(prices, self.short_window)
        long_ma = _moving_average(prices, self.long_window)

        if short_ma is None or long_ma is None or abs(long_ma) < 1e-12:
            return None

        diff_pct = (short_ma - long_ma) / long_ma * 100.0

        if diff_pct > 1.0:
            return TradeSignal(
                token=market_data.token,
                direction="BUY",
                strength=min(diff_pct / 10.0, 1.0),
                reason=(
                    f"SMA crossover: short({self.short_window})={short_ma:.2f} "
                    f"> long({self.long_window})={long_ma:.2f} ({diff_pct:+.2f}%)"
                ),
            )
        elif diff_pct < -1.0:
            return TradeSignal(
                token=market_data.token,
                direction="SELL",
                strength=min(abs(diff_pct) / 10.0, 1.0),
                reason=(
                    f"SMA crossover: short({self.short_window})={short_ma:.2f} "
                    f"< long({self.long_window})={long_ma:.2f} ({diff_pct:+.2f}%)"
                ),
            )
        return None
