from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService


@dataclass
class StopTradingAction:
    @property
    def name(self) -> str:
        return "STOP_TRADING"

    async def validate(self, message: Message, _state: dict) -> bool:  # type: ignore[type-arg]
        text = ((message.get("content") or {}).get("text") or "").lower()
        return "stop" in text or "end" in text or "disable" in text

    async def handler(
        self,
        message: Message,
        _state: dict,  # type: ignore[type-arg]
        service: TradingService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "TradingService is not available.", "missing_service")

        try:
            await service.stop_trading()
        except RuntimeError as exc:
            return ActionResult(False, str(exc), "stop_failed")

        return ActionResult(True, "Auto-trading stopped.")
