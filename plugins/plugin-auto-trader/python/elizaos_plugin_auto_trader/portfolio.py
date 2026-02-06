from __future__ import annotations

from elizaos_plugin_auto_trader.types import Holding, Portfolio, Trade


class PortfolioManager:
    """Manages an in-memory portfolio: holdings and trade history."""

    def __init__(self, initial_value: float = 10_000.0) -> None:
        self._holdings: dict[str, Holding] = {}
        self._trade_history: list[Trade] = []
        self._initial_value = initial_value

    def get_portfolio(self) -> Portfolio:
        total_value = sum(h.value for h in self._holdings.values())
        cost_basis = sum(h.avg_price * h.amount for h in self._holdings.values())
        pnl = total_value - cost_basis
        pnl_pct = (pnl / cost_basis * 100.0) if abs(cost_basis) > 1e-12 else 0.0
        return Portfolio(
            holdings=dict(self._holdings),
            total_value=total_value,
            pnl=pnl,
            pnl_pct=pnl_pct,
        )

    def update_holding(self, token: str, amount: float, price: float) -> None:
        if token not in self._holdings:
            self._holdings[token] = Holding(
                token=token,
                amount=0.0,
                avg_price=0.0,
                current_price=price,
                value=0.0,
                pnl=0.0,
            )

        h = self._holdings[token]

        if amount > 0:
            total_cost = h.avg_price * h.amount + price * amount
            h.amount += amount
            if h.amount > 1e-12:
                h.avg_price = total_cost / h.amount
        else:
            h.amount = max(0.0, h.amount + amount)

        h.current_price = price
        h.value = h.amount * h.current_price
        h.pnl = (h.current_price - h.avg_price) * h.amount

        if h.amount < 1e-12:
            del self._holdings[token]

    def update_price(self, token: str, price: float) -> None:
        if token in self._holdings:
            h = self._holdings[token]
            h.current_price = price
            h.value = h.amount * price
            h.pnl = (price - h.avg_price) * h.amount

    def record_trade(self, trade: Trade) -> None:
        if trade.status == "Executed":
            if trade.direction == "BUY":
                self.update_holding(trade.token, trade.amount, trade.price)
            else:
                self.update_holding(trade.token, -trade.amount, trade.price)
        self._trade_history.append(trade)

    def get_trade_history(self, limit: int = 0) -> list[Trade]:
        if limit <= 0 or limit >= len(self._trade_history):
            return list(self._trade_history)
        return list(self._trade_history[-limit:])

    def calculate_pnl(self) -> tuple[float, float]:
        portfolio = self.get_portfolio()
        pnl = portfolio.pnl
        pnl_pct = (
            (pnl / self._initial_value * 100.0)
            if abs(self._initial_value) > 1e-12
            else portfolio.pnl_pct
        )
        return pnl, pnl_pct

    @property
    def holdings_count(self) -> int:
        return len(self._holdings)

    @property
    def trade_count(self) -> int:
        return len(self._trade_history)
