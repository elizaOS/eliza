---
name: timeseries-detrending
description: Tools and techniques for detrending time series data in macroeconomic analysis. Use when working with economic time series that need to be decomposed into trend and cyclical components. Covers HP filter, log transformations for growth series, and correlation analysis of business cycles.
---

# Time Series Detrending for Macroeconomic Analysis

This skill provides guidance on decomposing economic time series into trend and cyclical components, a fundamental technique in business cycle analysis.

## Overview

Economic time series like GDP, consumption, and investment contain both long-term trends and short-term fluctuations (business cycles). Separating these components is essential for:
- Analyzing business cycle correlations
- Comparing volatility across variables
- Identifying leading/lagging indicators

## The Hodrick-Prescott (HP) Filter

The HP filter is the most widely used method for detrending macroeconomic data. It decomposes a time series into a trend component and a cyclical component.

### Mathematical Foundation

Given a time series $y_t$, the HP filter finds the trend $\tau_t$ that minimizes:

$$\sum_{t=1}^{T}(y_t - \tau_t)^2 + \lambda \sum_{t=2}^{T-1}[(\tau_{t+1} - \tau_t) - (\tau_t - \tau_{t-1})]^2$$

Where:
- First term: Minimizes deviation of data from trend
- Second term: Penalizes changes in the trend's growth rate
- $\lambda$: Smoothing parameter controlling the trade-off

### Choosing Lambda (λ)

**Critical**: The choice of λ depends on data frequency:

| Data Frequency | Recommended λ | Rationale |
|----------------|---------------|-----------|
| Annual         | **100**       | Standard for yearly data |
| Quarterly      | **1600**      | Hodrick-Prescott (1997) recommendation |
| Monthly        | **14400**     | Ravn-Uhlig (2002) adjustment |

**Common mistake**: Using λ=1600 (quarterly default) for annual data produces an overly smooth trend that misses important cyclical dynamics.

### Python Implementation

```python
from statsmodels.tsa.filters.hp_filter import hpfilter
import numpy as np

# Apply HP filter
# Returns: (cyclical_component, trend_component)
cycle, trend = hpfilter(data, lamb=100)  # For annual data

# For quarterly data
cycle_q, trend_q = hpfilter(quarterly_data, lamb=1600)
```

**Important**: The function parameter is `lamb` (not `lambda`, which is a Python keyword).

## Log Transformation for Growth Series

### Why Use Logs?

For most macroeconomic aggregates (GDP, consumption, investment), you should apply the natural logarithm **before** filtering:

1. **Multiplicative to Additive**: Converts percentage changes to log differences
2. **Stabilizes Variance**: Growth rates become comparable across time
3. **Economic Interpretation**: Cyclical component represents percentage deviations from trend
4. **Standard Practice**: Required for business cycle statistics that compare volatilities

```python
import numpy as np

# Apply log transformation BEFORE HP filtering
log_series = np.log(real_series)
cycle, trend = hpfilter(log_series, lamb=100)

# The cycle now represents percentage deviations from trend
# e.g., cycle = 0.02 means 2% above trend
```

### When NOT to Use Logs

- Series that can be negative (net exports, current account)
- Series already expressed as rates or percentages
- Series with zeros

## Complete Workflow for Detrending

### Step-by-Step Process

1. **Load and clean data**: Handle missing values, ensure proper time ordering
2. **Convert to real terms**: Deflate nominal values using appropriate price index
3. **Apply log transformation**: For positive level variables
4. **Apply HP filter**: Use appropriate λ for data frequency
5. **Analyze cyclical component**: Compute correlations, volatilities, etc.

### Example: Business Cycle Correlation

```python
import pandas as pd
import numpy as np
from statsmodels.tsa.filters.hp_filter import hpfilter

# Load real (inflation-adjusted) data
real_consumption = pd.Series(...)  # Real consumption expenditure
real_investment = pd.Series(...)   # Real fixed investment

# Log transformation
ln_consumption = np.log(real_consumption)
ln_investment = np.log(real_investment)

# HP filter with λ=100 for annual data
cycle_c, trend_c = hpfilter(ln_consumption, lamb=100)
cycle_i, trend_i = hpfilter(ln_investment, lamb=100)

# Compute correlation of cyclical components
correlation = np.corrcoef(cycle_c, cycle_i)[0, 1]
print(f"Business cycle correlation: {correlation:.4f}")
```

## Dependencies

Ensure these packages are installed:
```bash
pip install statsmodels pandas numpy
```

The HP filter is in `statsmodels.tsa.filters.hp_filter`.
