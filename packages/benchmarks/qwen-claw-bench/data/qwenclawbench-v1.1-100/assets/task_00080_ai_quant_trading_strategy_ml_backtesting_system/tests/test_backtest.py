"""
Unit tests for the backtesting engine.

Run with: pytest tests/test_backtest.py -v
"""

import pytest
import pandas as pd
import numpy as np


def make_sample_ohlcv(n=50, seed=42):
    """Create a small synthetic OHLCV DataFrame for testing."""
    np.random.seed(seed)
    dates = pd.bdate_range(start="2023-01-02", periods=n)
    close = 100 + np.cumsum(np.random.randn(n) * 0.5)
    high = close + np.abs(np.random.randn(n) * 0.3)
    low = close - np.abs(np.random.randn(n) * 0.3)
    open_ = close + np.random.randn(n) * 0.2
    volume = np.random.randint(1_000_000, 5_000_000, size=n)

    df = pd.DataFrame({
        "date": dates,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
    })
    return df


class TestBacktestInitialCapital:
    """Test that initial capital is handled correctly."""

    def test_no_trades_preserves_capital(self):
        """When there are no trade signals, capital should remain unchanged."""
        from main import run_backtest
        df = make_sample_ohlcv(50)
        signals = pd.Series(0, index=df.index)  # No signals
        result = run_backtest(
            df, signals,
            initial_capital=100000,
            commission_rate=0.001,
            slippage_bps=5
        )
        assert abs(result["equity_curve"].iloc[-1] - 100000) < 1e-6, \
            "Capital should be preserved when no trades are executed"


class TestCommission:
    """Test that commissions are deducted correctly."""

    def test_commission_deducted(self):
        """A single buy+sell round trip should deduct commission."""
        from main import run_backtest
        df = make_sample_ohlcv(50)
        # Signal: buy on day 5, sell on day 10
        signals = pd.Series(0, index=df.index)
        signals.iloc[5] = 1   # buy
        signals.iloc[10] = -1  # sell
        result = run_backtest(
            df, signals,
            initial_capital=100000,
            commission_rate=0.001,
            slippage_bps=0  # no slippage to isolate commission effect
        )
        # Final equity should differ from initial by price change minus commission
        assert result["total_commission"] > 0, "Commission should be charged"


class TestSlippage:
    """Test that slippage is applied correctly."""

    def test_slippage_applied(self):
        """Slippage should reduce returns compared to zero-slippage case."""
        from main import run_backtest
        df = make_sample_ohlcv(50)
        signals = pd.Series(0, index=df.index)
        signals.iloc[5] = 1
        signals.iloc[10] = -1

        result_no_slip = run_backtest(
            df, signals,
            initial_capital=100000,
            commission_rate=0.0,
            slippage_bps=0
        )
        result_with_slip = run_backtest(
            df, signals,
            initial_capital=100000,
            commission_rate=0.0,
            slippage_bps=10
        )
        # Slippage should reduce final equity
        assert result_with_slip["equity_curve"].iloc[-1] <= result_no_slip["equity_curve"].iloc[-1]


class TestEquityCurve:
    """Test equity curve properties."""

    def test_equity_curve_length(self):
        """Equity curve should have same length as input data."""
        from main import run_backtest
        df = make_sample_ohlcv(50)
        signals = pd.Series(0, index=df.index)
        result = run_backtest(
            df, signals,
            initial_capital=100000,
            commission_rate=0.001,
            slippage_bps=5
        )
        assert len(result["equity_curve"]) == len(df), \
            "Equity curve length should match data length"


class TestBuyAndHold:
    """Test buy-and-hold benchmark computation."""

    def test_buy_and_hold_return(self):
        """Buy-and-hold return should match price change from first to last close."""
        from main import compute_buy_and_hold
        df = make_sample_ohlcv(50)
        bnh_return = compute_buy_and_hold(df, initial_capital=100000)
        expected_return = (df["close"].iloc[-1] / df["close"].iloc[0]) - 1
        expected_final = 100000 * (1 + expected_return)
        assert abs(bnh_return - expected_final) < 1.0, \
            f"Buy-and-hold final value {bnh_return} should be close to {expected_final}"
