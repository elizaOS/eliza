from __future__ import annotations

import random as _random

from elizaos_plugin_auto_trader.types import MarketData, TradeSignal


class RandomStrategy:
    """Generate random buy/sell signals with configurable probability."""

    def __init__(
        self,
        buy_probability: float = 0.3,
        sell_probability: float = 0.3,
    ) -> None:
        self.buy_probability = max(0.0, min(1.0, buy_probability))
        self.sell_probability = max(0.0, min(1.0, sell_probability))

    @property
    def name(self) -> str:
        return "Random"

    async def analyze(self, market_data: MarketData) -> TradeSignal | None:
        roll = _random.random()

        if roll < self.buy_probability:
            return TradeSignal(
                token=market_data.token,
                direction="BUY",
                strength=roll / self.buy_probability if self.buy_probability > 0 else 0,
                reason="Random buy signal",
            )
        elif roll < self.buy_probability + self.sell_probability:
            return TradeSignal(
                token=market_data.token,
                direction="SELL",
                strength=(
                    (roll - self.buy_probability) / self.sell_probability
                    if self.sell_probability > 0
                    else 0
                ),
                reason="Random sell signal",
            )
        return None
