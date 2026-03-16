from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.types import StrategyConfig, TradingStrategy


def _parse_strategy(text: str) -> TradingStrategy:
    lower = text.lower()
    if "rule" in lower or "technical" in lower:
        return TradingStrategy.RULE_BASED
    if "llm" in lower or "ai" in lower or "smart" in lower:
        return TradingStrategy.LLM_DRIVEN
    return TradingStrategy.RANDOM


@dataclass
class StartTradingAction:
    @property
    def name(self) -> str:
        return "START_TRADING"

    async def validate(self, message: Message, _state: dict) -> bool:  # type: ignore[type-arg]
        text = ((message.get("content") or {}).get("text") or "").lower()
        return "start" in text or "begin" in text or "enable" in text

    async def handler(
        self,
        message: Message,
        state: dict,  # type: ignore[type-arg]
        service: TradingService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "TradingService is not available.", "missing_service")

        text = (message.get("content") or {}).get("text") or ""
        strategy = _parse_strategy(state.get("strategy", text))
        risk = float(state.get("risk_level", 0.5))

        config = StrategyConfig(strategy=strategy, risk_level=risk)
        try:
            await service.start_trading(config)
        except RuntimeError as exc:
            return ActionResult(False, str(exc), "start_failed")

        return ActionResult(True, f"Auto-trading started with {strategy.value} strategy.")
