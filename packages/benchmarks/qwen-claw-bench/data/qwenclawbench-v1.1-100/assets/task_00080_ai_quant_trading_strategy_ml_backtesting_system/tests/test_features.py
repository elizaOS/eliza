"""
Unit tests for feature engineering functions.

Run with: pytest tests/test_features.py -v
"""

import pytest
import pandas as pd
import numpy as np


def make_sample_ohlcv(n=100, seed=42):
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


class TestAdaptiveBollinger:
    """Tests for compute_adaptive_bollinger function."""

    def test_output_shape(self):
        """Output should have same number of rows as input with expected columns."""
        from main import compute_adaptive_bollinger
        df = make_sample_ohlcv(100)
        result = compute_adaptive_bollinger(df, window=20, num_std=2.0, vol_lookback=30)
        assert len(result) == len(df)
        for col in ["bb_mid", "bb_upper", "bb_lower", "bb_bandwidth", "bb_pct"]:
            assert col in result.columns, f"Missing column: {col}"

    def test_no_nan_after_warmup(self):
        """After warmup period, there should be no NaN values."""
        from main import compute_adaptive_bollinger
        df = make_sample_ohlcv(100)
        result = compute_adaptive_bollinger(df, window=20, num_std=2.0, vol_lookback=30)
        warmup = 30  # max of window and vol_lookback
        after_warmup = result.iloc[warmup:]
        for col in ["bb_mid", "bb_upper", "bb_lower"]:
            assert after_warmup[col].notna().all(), f"NaN found in {col} after warmup"

    def test_upper_above_lower(self):
        """Upper band should always be above lower band."""
        from main import compute_adaptive_bollinger
        df = make_sample_ohlcv(100)
        result = compute_adaptive_bollinger(df, window=20, num_std=2.0, vol_lookback=30)
        valid = result.dropna(subset=["bb_upper", "bb_lower"])
        assert (valid["bb_upper"] >= valid["bb_lower"]).all()


class TestRSI:
    """Tests for compute_rsi function."""

    def test_values_in_range(self):
        """RSI values should be between 0 and 100."""
        from main import compute_rsi
        df = make_sample_ohlcv(100)
        result = compute_rsi(df, period=14)
        valid_rsi = result["rsi"].dropna()
        assert (valid_rsi >= 0).all(), "RSI below 0 detected"
        assert (valid_rsi <= 100).all(), "RSI above 100 detected"

    def test_output_length(self):
        """RSI output should have same length as input."""
        from main import compute_rsi
        df = make_sample_ohlcv(100)
        result = compute_rsi(df, period=14)
        assert len(result) == len(df)


class TestATR:
    """Tests for compute_atr function."""

    def test_positive_values(self):
        """ATR should always be positive."""
        from main import compute_atr
        df = make_sample_ohlcv(100)
        result = compute_atr(df, period=14)
        valid_atr = result["atr"].dropna()
        assert (valid_atr > 0).all(), "Non-positive ATR detected"

    def test_normalized_atr_positive(self):
        """Normalized ATR should be positive."""
        from main import compute_atr
        df = make_sample_ohlcv(100)
        result = compute_atr(df, period=14)
        valid = result["atr_norm"].dropna()
        assert (valid > 0).all(), "Non-positive normalized ATR detected"


class TestRSIDivergence:
    """Tests for detect_rsi_divergence function."""

    def test_returns_boolean_series(self):
        """Divergence detection should return boolean columns."""
        from main import detect_rsi_divergence
        df = make_sample_ohlcv(100)
        result = detect_rsi_divergence(df)
        assert result["rsi_bullish_div"].dtype == bool or result["rsi_bullish_div"].dtype == np.bool_
        assert result["rsi_bearish_div"].dtype == bool or result["rsi_bearish_div"].dtype == np.bool_

    def test_output_columns_exist(self):
        """Should produce rsi_bullish_div and rsi_bearish_div columns."""
        from main import detect_rsi_divergence
        df = make_sample_ohlcv(100)
        result = detect_rsi_divergence(df)
        assert "rsi_bullish_div" in result.columns
        assert "rsi_bearish_div" in result.columns
