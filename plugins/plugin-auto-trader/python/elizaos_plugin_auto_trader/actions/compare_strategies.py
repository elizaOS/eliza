from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.types import TradingStrategy


@dataclass
class CompareStrategiesAction:
    @property
    def name(self) -> str:
        return "COMPARE_STRATEGIES"

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

        period = int(state.get("period_days", 30))
        strategies = [
            TradingStrategy.RANDOM,
            TradingStrategy.RULE_BASED,
            TradingStrategy.LLM_DRIVEN,
        ]

        results = await service.compare_strategies(strategies, period)

        lines = [f"Strategy Comparison ({period} days):"]
        for r in results:
            lines.append(
                f"  {r.strategy.value}: PnL=${r.total_pnl:.2f}, "
                f"WinRate={r.win_rate * 100:.1f}%, "
                f"Drawdown={r.max_drawdown * 100:.2f}%, "
                f"Sharpe={r.sharpe_ratio:.2f}"
            )

        return ActionResult(True, "\n".join(lines), data=results)
