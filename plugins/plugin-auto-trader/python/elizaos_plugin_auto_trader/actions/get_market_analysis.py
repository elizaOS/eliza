from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService


@dataclass
class GetMarketAnalysisAction:
    @property
    def name(self) -> str:
        return "GET_MARKET_ANALYSIS"

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

        token = state.get("token", "SOL")
        analysis = await service.get_market_analysis(token)

        text = (
            f"Market Analysis for {analysis.token}:\n"
            f"  Trend: {analysis.trend}\n"
            f"  Support: ${analysis.support:.4f}\n"
            f"  Resistance: ${analysis.resistance:.4f}\n"
            f"  Volume (24h): ${analysis.volume_24h:.0f}\n"
            f"  Recommendation: {analysis.recommendation}"
        )

        return ActionResult(True, text, data=analysis)
