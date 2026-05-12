# System Architecture — AI Quant Backtesting System

## Overview

This document describes the architecture of the AI-driven quantitative backtesting system. The system implements a machine learning–based trading strategy using technical features, triple barrier labeling, and an event-driven backtester.

**`main.py` should be self-contained and runnable.** It must support both loading OHLCV data from `data/ohlcv_sample.csv` and generating simulated OHLCV data internally for demonstration purposes.

---

## Module Pipeline

### 1. Feature Engineering

The feature engineering module computes the following technical indicators from OHLCV data:

- **Adaptive Bollinger Bands**: Standard Bollinger Bands (20-period SMA ± 2 standard deviations) with bandwidth that adapts based on the recent volatility regime. When realized volatility over the lookback window exceeds its own moving average, the band multiplier widens; when volatility contracts, the bands tighten.

- **RSI with Divergence Detection**: The standard 14-period RSI is computed, and a divergence detector identifies bullish and bearish divergences between price action and RSI values over a configurable lookback window.

- **ATR-based Volatility**: The 14-period Average True Range (ATR) is used as a volatility measure. Normalized ATR (ATR / Close) provides a scale-independent volatility metric.

All features should be computed as new columns appended to the price DataFrame. The first `max(bb_window, rsi_period, atr_period)` rows will contain NaN values due to warmup requirements.

### 2. Triple Barrier Labeling

Labels are generated using the triple barrier method (see `docs/triple_barrier_reference.md`):

- **Upper barrier**: profit-taking threshold (default: +2% from entry)
- **Lower barrier**: stop-loss threshold (default: -2% from entry)
- **Vertical barrier**: maximum holding period (default: 10 trading days)

The label is **1** (positive) if the upper barrier is hit first, **0** otherwise.

### 3. XGBoost Model Training

An XGBoost classifier is trained on the engineered features with triple barrier labels:

- Handle class imbalance using `scale_pos_weight` (auto-computed from label distribution)
- Use `n_estimators=150`, `max_depth=6`, `learning_rate=0.05`
- Train/test split should be **temporal** (no shuffling) — e.g., first 70% train, last 30% test
- Predictions are filtered by a confidence threshold (default: 0.65) before generating trade signals

### 4. Event-Driven Backtester

The backtester simulates trading based on model signals:

- **Initial capital**: $100,000
- **Commission**: 0.1% per trade (0.001)
- **Slippage**: 5 basis points
- Tracks equity curve, positions, and trade log
- Computes performance metrics: total return, Sharpe ratio, max drawdown, win rate
- Includes a **buy-and-hold benchmark** for comparison

### 5. Visualization

Generate plots saved to the `output/` directory:

- Equity curve (strategy vs. buy-and-hold)
- Drawdown chart
- Feature importance bar chart from XGBoost
- Trade entry/exit markers on price chart

---

## File Structure

```
├── main.py                    # Self-contained entry point
├── data/
│   └── ohlcv_sample.csv      # Primary OHLCV data (already adjusted)
├── config/
│   └── strategy_params.yaml   # Strategy configuration
├── docs/
│   ├── architecture.md        # This document
│   ├── triple_barrier_reference.md
│   └── README.md
├── tests/
│   ├── test_features.py
│   └── test_backtest.py
├── output/                    # Generated plots and results
└── requirements.txt
```

---

## Notes

- All prices in `ohlcv_sample.csv` are **already adjusted** for splits and dividends.
- The system should gracefully handle NaN values from feature warmup periods.
- Random seed should be set for reproducibility in model training.
