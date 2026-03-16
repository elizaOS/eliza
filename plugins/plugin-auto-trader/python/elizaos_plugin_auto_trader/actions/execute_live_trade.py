from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService


@dataclass
class ExecuteLiveTradeAction:
    @property
    def name(self) -> str:
        return "EXECUTE_LIVE_TRADE"

    async def validate(self, _message: Message, _state: dict) -> bool:  # type: ignore[type-arg]
        return True

    async def handler(
        self,
        message: Message,
        state: dict,  # type: ignore[type-arg]
        service: TradingService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "TradingService is not available.", "missing_service")

        token = state.get("token", "SOL")
        amount = float(state.get("amount", 1.0))
        text = (message.get("content") or {}).get("text") or ""
        direction_hint = state.get("direction", text)
        direction = "SELL" if "sell" in str(direction_hint).lower() else "BUY"

        try:
            trade = await service.execute_trade(token, direction, amount)
        except RuntimeError as exc:
            return ActionResult(False, str(exc), "trade_failed")

        return ActionResult(
            True,
            f"Trade executed: {trade.direction} {trade.amount:.4f} "
            f"{trade.token} @ ${trade.price:.4f} (ID: {trade.id})",
            data=trade,
        )
