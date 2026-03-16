from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService


@dataclass
class CheckPortfolioAction:
    @property
    def name(self) -> str:
        return "CHECK_PORTFOLIO"

    async def validate(self, _message: Message, _state: dict) -> bool:  # type: ignore[type-arg]
        return True

    async def handler(
        self,
        _message: Message,
        _state: dict,  # type: ignore[type-arg]
        service: TradingService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "TradingService is not available.", "missing_service")

        portfolio = await service.check_portfolio()
        lines = [
            f"Portfolio: ${portfolio.total_value:.2f} "
            f"| PnL: ${portfolio.pnl:.2f} ({portfolio.pnl_pct:+.2f}%)"
        ]

        if portfolio.holdings:
            for token, h in portfolio.holdings.items():
                lines.append(
                    f"  {token}: {h.amount:.4f} @ ${h.current_price:.4f} "
                    f"= ${h.value:.2f} (PnL: ${h.pnl:.2f})"
                )
        else:
            lines.append("  No open positions.")

        return ActionResult(True, "\n".join(lines), data=portfolio)
