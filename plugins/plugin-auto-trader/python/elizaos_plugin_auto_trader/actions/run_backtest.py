from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.types import TradingStrategy


def _parse_strategy(val: str) -> TradingStrategy:
    lower = val.lower()
    if lower in ("rule_based", "rulebased", "rule-based", "technical"):
        return TradingStrategy.RULE_BASED
    if lower in ("llm", "llm_driven", "ai"):
        return TradingStrategy.LLM_DRIVEN
    return TradingStrategy.RANDOM


@dataclass
class RunBacktestAction:
    @property
    def name(self) -> str:
        return "RUN_BACKTEST"

    async def validate(self, _message: Message, _state: dict) -> bool:  # type: ignore[type-arg]
        return True

    async def handler(
        self,
        _message: Message,
        state: dict,  # type: ignore[type-arg]
        service: TradingService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "TradingService is not available.", "missing_service")

        strategy = _parse_strategy(state.get("strategy", "random"))
        period = int(state.get("period_days", 30))

        result = await service.run_backtest(strategy, period)

        text = (
            f"Backtest Results ({strategy.value}, {period} days):\n"
            f"  Trades: {len(result.trades)}\n"
            f"  Total PnL: ${result.total_pnl:.2f}\n"
            f"  Win Rate: {result.win_rate * 100:.1f}%\n"
            f"  Max Drawdown: {result.max_drawdown * 100:.2f}%\n"
            f"  Sharpe Ratio: {result.sharpe_ratio:.2f}"
        )

        return ActionResult(True, text, data=result)
