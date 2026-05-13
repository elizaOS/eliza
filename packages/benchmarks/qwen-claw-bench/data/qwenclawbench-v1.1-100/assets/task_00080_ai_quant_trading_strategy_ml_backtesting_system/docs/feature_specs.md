# Feature Specifications

## Overview

This document specifies the technical features used by the AI Quant Backtesting System. All features are computed from OHLCV data and appended as new columns to the working DataFrame.

---

## 1. Adaptive Bollinger Bands

### Description

Bollinger Bands consist of a middle band (simple moving average) and upper/lower bands at a configurable number of standard deviations from the middle band. Our implementation adds an **adaptive** component: the band width adjusts based on the recent volatility regime.

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `bb_window` | 20 | Lookback window for SMA and standard deviation |
| `bb_std` | 2.0 | Base number of standard deviations |
| `volatility_lookback` | 30 | Window for assessing volatility regime |

### Computation

1. Compute the 20-period SMA of closing prices: `bb_mid = SMA(close, 20)`
2. Compute the 20-period rolling standard deviation: `bb_std_val = STD(close, 20)`
3. Compute the volatility regime factor:
   - `recent_vol = STD(returns, volatility_lookback)`
   - `vol_sma = SMA(recent_vol, volatility_lookback)`
   - `vol_ratio = recent_vol / vol_sma`
4. Adaptive multiplier: `adaptive_mult = bb_std × vol_ratio`
5. Upper band: `bb_upper = bb_mid + adaptive_mult × bb_std_val`
6. Lower band: `bb_lower = bb_mid - adaptive_mult × bb_std_val`

### Output Columns

- `bb_mid`: Middle band (SMA)
- `bb_upper`: Upper adaptive band
- `bb_lower`: Lower adaptive band
- `bb_bandwidth`: `(bb_upper - bb_lower) / bb_mid`
- `bb_pct`: `(close - bb_lower) / (bb_upper - bb_lower)` — position within bands (0 = at lower, 1 = at upper)

---

## 2. RSI with Divergence Detection

### Description

The Relative Strength Index (RSI) is a momentum oscillator that measures the speed and magnitude of price movements. We compute the standard RSI and additionally detect **divergences** between price and RSI.

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `rsi_period` | 14 | Lookback period for RSI calculation |

### RSI Computation

1. Compute daily price changes: `delta = close.diff()`
2. Separate gains and losses: `gain = max(delta, 0)`, `loss = abs(min(delta, 0))`
3. Compute exponential moving averages: `avg_gain = EMA(gain, rsi_period)`, `avg_loss = EMA(loss, rsi_period)`
4. Relative Strength: `RS = avg_gain / avg_loss`
5. RSI: `RSI = 100 - (100 / (1 + RS))`

### Divergence Detection

Divergences are detected by comparing recent swing points in price and RSI:

- **Bullish Divergence**: Occurs when price makes **higher lows** while RSI makes **higher lows**, indicating potential upward reversal momentum building beneath the surface. This signal suggests accumulation despite apparent price weakness.

- **Bearish Divergence**: Occurs when price makes **higher highs** while RSI makes **lower highs**, indicating weakening momentum despite rising prices.

Swing points are identified using a 5-bar lookback window for local minima/maxima detection.

### Output Columns

- `rsi`: RSI value (0–100)
- `rsi_bullish_div`: Boolean, True when bullish divergence detected
- `rsi_bearish_div`: Boolean, True when bearish divergence detected

---

## 3. ATR-based Volatility

### Description

The Average True Range (ATR) measures market volatility by computing the average of true ranges over a specified period.

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `atr_period` | 14 | Lookback period for ATR |

### Computation

1. True Range for each bar:
   ```
   TR = max(
       high - low,
       abs(high - prev_close),
       abs(low - prev_close)
   )
   ```
2. ATR: `ATR = SMA(TR, atr_period)` (or EMA variant)
3. Normalized ATR: `ATR_norm = ATR / close`

### Output Columns

- `atr`: Average True Range (absolute)
- `atr_norm`: Normalized ATR (ATR / close), useful as a scale-independent volatility measure

---

## Feature Summary Table

| Feature | Column Name | Type | Range |
|---------|-------------|------|-------|
| BB Middle | `bb_mid` | float | Price scale |
| BB Upper | `bb_upper` | float | Price scale |
| BB Lower | `bb_lower` | float | Price scale |
| BB Bandwidth | `bb_bandwidth` | float | 0+ |
| BB Percent | `bb_pct` | float | ~0–1 (can exceed) |
| RSI | `rsi` | float | 0–100 |
| RSI Bullish Div | `rsi_bullish_div` | bool | True/False |
| RSI Bearish Div | `rsi_bearish_div` | bool | True/False |
| ATR | `atr` | float | 0+ |
| ATR Normalized | `atr_norm` | float | 0+ |

---

## Warmup Period

Features require a warmup period equal to the maximum lookback window across all indicators. For default parameters:

- Bollinger Bands: max(window=20, volatility_lookback=30) = 30 bars
- RSI: 14 bars
- ATR: 14 bars

**Effective warmup: 30 bars** (dominated by the Bollinger Band volatility_lookback window). The first 30 rows of computed features will contain NaN values and should be dropped before model training.
