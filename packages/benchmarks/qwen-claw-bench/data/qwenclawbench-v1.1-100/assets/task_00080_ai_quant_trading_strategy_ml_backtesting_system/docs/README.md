# AI Quant Backtesting System

An end-to-end machine learning–driven quantitative trading backtesting system. It combines adaptive technical indicators, triple barrier labeling, XGBoost classification, and an event-driven backtester to evaluate trading strategies on historical equity data.

## Overview

The system implements the following pipeline:

1. **Feature Engineering** — Adaptive Bollinger Bands, RSI with divergence detection, ATR-based volatility
2. **Triple Barrier Labeling** — Forward-looking labels based on profit-take, stop-loss, and max holding period
3. **XGBoost Model** — Classifier trained on technical features with class imbalance handling
4. **Event-Driven Backtester** — Simulates trading with realistic commission and slippage
5. **Visualization** — Equity curves, drawdown charts, feature importance, trade markers

## Setup

```bash
pip install -r requirements.txt
```

## Usage

```bash
python main.py
```

The script is self-contained and can operate in two modes:

- **File mode**: Loads OHLCV data from `data/ohlcv_sample.csv`
- **Simulated mode**: Generates synthetic OHLCV data internally if the data file is not found

Output plots and results are saved to the `output/` directory.

## Data

- `data/ohlcv_sample.csv` — Primary OHLCV price data (504 trading days, 2022–2023). **Prices are already adjusted for splits and dividends.** Do not apply additional corporate action adjustments.

## Configuration

Strategy parameters are defined in `config/strategy_params.yaml`, including:

- Feature engineering settings (Bollinger Band window, RSI period, ATR period)
- Triple barrier thresholds (profit take, stop loss, max holding period)
- XGBoost hyperparameters (estimators, depth, learning rate, confidence threshold)
- Backtest settings (initial capital, commission rate, slippage)

## Project Structure

```
├── main.py                     # Self-contained entry point
├── requirements.txt            # Python dependencies
├── data/
│   └── ohlcv_sample.csv       # Adjusted OHLCV data
├── config/
│   └── strategy_params.yaml   # Strategy configuration
├── docs/
│   ├── README.md              # This file
│   ├── architecture.md        # System architecture
│   ├── triple_barrier_reference.md  # Triple barrier method reference
│   └── feature_specs.md       # Feature specifications
├── tests/
│   ├── test_features.py       # Feature engineering tests
│   └── test_backtest.py       # Backtester tests
├── logs/                      # Historical run logs
└── output/                    # Generated plots and results
```

## Notes

- Ensure reproducibility by setting random seeds in model training.
- The first ~30 rows of features will be NaN due to indicator warmup periods.
- Class imbalance in labels is handled via `scale_pos_weight` in XGBoost.
