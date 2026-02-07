from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.types import StrategyConfig, TradingStrategy


def _parse_strategy(val: str) -> TradingStrategy:
    lower = val.lower()
    if lower in ("rule_based", "rulebased", "rule-based", "technical"):
        return TradingStrategy.RULE_BASED
    if lower in ("llm", "llm_driven", "ai"):
        return TradingStrategy.LLM_DRIVEN
    return TradingStrategy.RANDOM


@dataclass
class ConfigureStrategyAction:
    @property
    def name(self) -> str:
        return "CONFIGURE_STRATEGY"

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

        current = await service.get_strategy_config()

        strategy = _parse_strategy(state.get("strategy", current.strategy.value))
        config = StrategyConfig(
            strategy=strategy,
            risk_level=float(state.get("risk_level", current.risk_level)),
            max_position_size=float(state.get("max_position_size", current.max_position_size)),
            stop_loss_pct=float(state.get("stop_loss_pct", current.stop_loss_pct)),
            take_profit_pct=float(state.get("take_profit_pct", current.take_profit_pct)),
            max_daily_trades=int(state.get("max_daily_trades", current.max_daily_trades)),
        )

        try:
            await service.configure_strategy(config)
        except (ValueError, RuntimeError) as exc:
            return ActionResult(False, str(exc), "configure_failed")

        return ActionResult(
            True,
            f"Strategy configured: {config.strategy.value} "
            f"(risk={config.risk_level:.2f}, "
            f"max_pos={config.max_position_size * 100:.0f}%, "
            f"SL={config.stop_loss_pct:.1f}%, "
            f"TP={config.take_profit_pct:.1f}%, "
            f"max_trades={config.max_daily_trades})",
        )
