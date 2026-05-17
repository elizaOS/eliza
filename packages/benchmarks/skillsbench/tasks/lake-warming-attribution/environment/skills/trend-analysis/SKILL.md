---
name: trend-analysis
description: Detect long-term trends in time series data using parametric and non-parametric methods. Use when determining if a variable shows statistically significant increase or decrease over time.
license: MIT
---

# Trend Analysis Guide

## Overview

Trend analysis determines whether a time series shows a statistically significant long-term increase or decrease. This guide covers both parametric (linear regression) and non-parametric (Sen's slope) methods.

## Parametric Method: Linear Regression

Linear regression fits a straight line to the data and tests if the slope is significantly different from zero.
```python
from scipy import stats

slope, intercept, r_value, p_value, std_err = stats.linregress(years, values)

print(f"Slope: {slope:.2f} units/year")
print(f"p-value: {p_value:.2f}")
```

### Assumptions

- Linear relationship between time and variable
- Residuals are normally distributed
- Homoscedasticity (constant variance)

## Non-Parametric Method: Sen's Slope with Mann-Kendall Test

Sen's slope is robust to outliers and does not assume normality. Recommended for environmental data.
```python
import pymannkendall as mk

result = mk.original_test(values)

print(result.slope)  # Sen's slope (rate of change per time unit)
print(result.p)      # p-value for significance
print(result.trend)  # 'increasing', 'decreasing', or 'no trend'
```

### Comparison

| Method | Pros | Cons |
|--------|------|------|
| Linear Regression | Easy to interpret, gives R² | Sensitive to outliers |
| Sen's Slope | Robust to outliers, no normality assumption | Slightly less statistical power |

## Significance Levels

| p-value | Interpretation |
|---------|----------------|
| p < 0.01 | Highly significant trend |
| p < 0.05 | Significant trend |
| p < 0.10 | Marginally significant |
| p >= 0.10 | No significant trend |

## Example: Annual Precipitation Trend
```python
import pandas as pd
import pymannkendall as mk

# Load annual precipitation data
df = pd.read_csv('precipitation.csv')
precip = df['Precipitation'].values

# Run Mann-Kendall test
result = mk.original_test(precip)
print(f"Sen's slope: {result.slope:.2f} mm/year")
print(f"p-value: {result.p:.2f}")
print(f"Trend: {result.trend}")
```

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| p-value = NaN | Too few data points | Need at least 8-10 years |
| Conflicting results | Methods have different assumptions | Trust Sen's slope for environmental data |
| Slope near zero but significant | Large sample size | Check practical significance |

## Best Practices

- Use at least 10 data points for reliable results
- Prefer Sen's slope for environmental time series
- Report both slope magnitude and p-value
- Round results to 2 decimal places
