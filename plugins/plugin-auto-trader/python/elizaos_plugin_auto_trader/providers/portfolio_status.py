from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import Message
from elizaos_plugin_auto_trader.service import TradingService


@dataclass(frozen=True)
class ProviderResult:
    values: dict[str, str]
    text: str
    data: dict[str, str | int | float]


class PortfolioStatusProvider:
    @property
    def name(self) -> str:
        return "PORTFOLIO_STATUS"

    @property
    def description(self) -> str:
        return "Provides current portfolio holdings, PnL, and trading state"

    @property
    def position(self) -> int:
        return 50

    async def get(
        self,
        _message: Message,
        _state: dict,  # type: ignore[type-arg]
        service: TradingService | None = None,
    ) -> ProviderResult:
        if service is None:
            return ProviderResult(
                values={
                    "portfolioStatus": "Trading service is not available",
                    "tradingState": "unknown",
                },
                text="# Portfolio Status\n\nTrading service is not available.",
                data={"holdings": 0, "state": "unknown"},
            )

        portfolio = await service.check_portfolio()
        state = await service.get_state()
        config = await service.get_strategy_config()
        history = await service.get_trade_history(5)

        text_parts = [
            "# Portfolio Status",
            "",
            f"State: {state}",
            f"Strategy: {config.strategy.value}",
            f"Total Value: ${portfolio.total_value:.2f} "
            f"| PnL: ${portfolio.pnl:.2f} ({portfolio.pnl_pct:+.2f}%)",
            "",
            "## Holdings",
        ]

        if not portfolio.holdings:
            text_parts.append("No open positions.")
        else:
            for token, h in portfolio.holdings.items():
                text_parts.append(
                    f"- {token}: {h.amount:.4f} @ ${h.current_price:.4f} "
                    f"= ${h.value:.2f} (PnL: ${h.pnl:.2f})"
                )

        if history:
            text_parts.append("")
            text_parts.append("## Recent Trades")
            for t in history:
                text_parts.append(
                    f"- {t.timestamp.strftime('%H:%M:%S')} {t.direction} "
                    f"{t.amount:.4f} {t.token} @ ${t.price:.4f}"
                )

        return ProviderResult(
            values={
                "portfolioStatus": (
                    f"${portfolio.total_value:.2f} "
                    f"| PnL: ${portfolio.pnl:.2f} ({portfolio.pnl_pct:+.2f}%)"
                ),
                "tradingState": state,
                "strategy": config.strategy.value,
            },
            text="\n".join(text_parts),
            data={
                "holdings": len(portfolio.holdings),
                "totalValue": portfolio.total_value,
                "pnl": portfolio.pnl,
                "state": state,
                "recentTrades": len(history),
            },
        )
