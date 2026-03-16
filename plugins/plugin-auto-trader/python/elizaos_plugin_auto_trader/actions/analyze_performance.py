from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_auto_trader.actions.common import ActionResult, Message
from elizaos_plugin_auto_trader.service import TradingService


@dataclass
class AnalyzePerformanceAction:
    @property
    def name(self) -> str:
        return "ANALYZE_PERFORMANCE"

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

        report = await service.analyze_performance()

        text = (
            f"Performance Report:\n"
            f"  Total Trades: {report.total_trades}\n"
            f"  Winning: {report.winning_trades} | Losing: {report.losing_trades}\n"
            f"  Win Rate: {report.win_rate * 100:.1f}%\n"
            f"  Total PnL: ${report.total_pnl:.2f} ({report.total_pnl_pct:+.2f}%)\n"
            f"  Avg Win: ${report.avg_win:.2f} | Avg Loss: ${report.avg_loss:.2f}\n"
            f"  Max Drawdown: {report.max_drawdown * 100:.2f}%\n"
            f"  Sharpe Ratio: {report.sharpe_ratio:.2f}"
        )

        return ActionResult(True, text, data=report)
