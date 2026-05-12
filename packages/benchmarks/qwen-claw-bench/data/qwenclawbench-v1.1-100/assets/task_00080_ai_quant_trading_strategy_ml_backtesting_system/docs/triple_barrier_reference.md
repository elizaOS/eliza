# Triple Barrier Method — Reference

## Overview

The triple barrier method is a labeling technique for financial machine learning, originally described by **Marcos López de Prado** in *Advances in Financial Machine Learning* (2018). It provides a structured way to label price observations for supervised learning by defining three exit conditions (barriers) for each trade entry.

## The Three Barriers

### 1. Upper Barrier (Profit Take)

The upper barrier is set at a fixed percentage above the entry price. When the price reaches this level, the trade is considered a **profitable exit**.

```
upper_barrier = entry_price × (1 + profit_take)
```

Where `profit_take` is a positive decimal (e.g., 0.02 for 2%).

### 2. Lower Barrier (Stop Loss)

The lower barrier is set at a fixed percentage below the entry price. When the price reaches this level, the trade is considered a **loss exit**.

```
lower_barrier = entry_price × (1 + stop_loss)
```

Where `stop_loss` is a negative decimal (e.g., -0.02 for -2%). Note: the stop_loss parameter should be negative.

### 3. Vertical Barrier (Maximum Holding Period)

The vertical barrier is a time-based constraint. If neither the upper nor lower barrier is hit within `max_holding` trading days, the position is closed at the prevailing price.

```
vertical_barrier = entry_date + max_holding trading days
```

## Labeling Rule

For each observation at time *t*:

1. Set the three barriers based on the entry price at time *t*.
2. Look forward in time from *t+1* to *t+max_holding*.
3. Determine which barrier is touched **first**:
   - If the **upper barrier** is hit first → **Label = 1** (positive outcome)
   - If the **lower barrier** is hit first → **Label = 0** (negative outcome)
   - If the **vertical barrier** is reached (timeout) → Label based on whether the final price is above or below entry (typically **Label = 0** for conservative labeling)

## Volatility-Scaled Barriers

In the advanced formulation, barriers can be set as multiples of daily volatility (e.g., ATR or rolling standard deviation of returns):

```
upper_barrier = entry_price × (1 + multiplier × daily_volatility)
lower_barrier = entry_price × (1 - multiplier × daily_volatility)
```

This makes the barriers adaptive to current market conditions. In high-volatility regimes, barriers widen; in low-volatility regimes, they tighten.

## Implementation Notes

- The labeling process is inherently **forward-looking** and should only be used for training labels, never as a real-time feature.
- When using fixed percentage barriers (as in our default configuration: ±2%, 10-day holding), the method is simpler but less adaptive.
- Class imbalance is common — there are often more negative labels than positive ones, which is why `scale_pos_weight` is used in the XGBoost model.

## References

- López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
- Chapter 3: "Labeling" — Triple Barrier Method
- Chapter 4: "Sample Weights" — Handling overlapping labels
