# Sector Rotation Strategy — Implementation Notes

## Data Preprocessing
- All price data should be adjusted for corporate actions (splits, dividends) before
  computing any returns. Check the sector metadata file for split history.
- Missing data points: use the method specified in `strategy_params.yaml` (default:
  linear interpolation between nearest available data points).
- Duplicate entries: if the same date appears twice for a ticker, keep the **first**
  occurrence and discard later duplicates.

## Momentum Calculation
- The momentum score at rebalancing week `t` is a simple return:
  `score = close[t - skip_recent] / close[t - skip_recent - lookback] - 1`
- Where `skip_recent` and `lookback` are defined in `strategy_params.yaml`.
- Higher scores indicate stronger momentum; sectors are ranked descending.

## Portfolio Construction Rules
- Select the top N sectors by momentum score.
- Equal-weight allocation across selected sectors.
- **Risk override**: any sector showing negative 4-week momentum at the rebalancing
  date must be excluded from selection, regardless of its 12-week score. Replace it
  with the next eligible sector by rank. The 4-week momentum is calculated the same
  way as the main score but with a 4-week lookback (and the same `skip_recent`).
- Rebalancing occurs at the specified frequency; the portfolio is held unchanged
  between rebalancing dates.

## Performance Metrics
- Report total cumulative return, annualized return, annualized volatility,
  Sharpe ratio (using the risk-free rate from config), and maximum drawdown.
- Compare all metrics against the SPY benchmark over the same period.
- Transaction costs should be deducted from returns at each rebalancing.

## Transaction Cost Model
- At each rebalance, every position change incurs: commission (per trade, per side)
  plus spread cost (in basis points of trade notional).
- A full portfolio turnover (selling 3 old + buying 3 new) = 6 trades.
- If a sector is held across rebalances, no transaction cost for that position.
