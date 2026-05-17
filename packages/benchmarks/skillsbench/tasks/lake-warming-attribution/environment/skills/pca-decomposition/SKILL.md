---
name: pca-decomposition
description: Reduce dimensionality of multivariate data using PCA with varimax rotation. Use when you have many correlated variables and need to identify underlying factors or reduce collinearity.
license: MIT
---

# PCA Decomposition Guide

## Overview

Principal Component Analysis (PCA) reduces many correlated variables into fewer uncorrelated components. Varimax rotation makes components more interpretable by maximizing variance.

## When to Use PCA

- Many correlated predictor variables
- Need to identify underlying factor groups
- Reduce multicollinearity before regression
- Exploratory data analysis

## Basic PCA with Varimax Rotation
```python
from sklearn.preprocessing import StandardScaler
from factor_analyzer import FactorAnalyzer

# Standardize data first
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# PCA with varimax rotation
fa = FactorAnalyzer(n_factors=4, rotation='varimax')
fa.fit(X_scaled)

# Get factor loadings
loadings = fa.loadings_

# Get component scores for each observation
scores = fa.transform(X_scaled)
```

## Workflow for Attribution Analysis

When using PCA for contribution analysis with predefined categories:

1. **Combine ALL variables first**, then do PCA together:
```python
# Include all variables from all categories in one matrix
all_vars = ['AirTemp', 'NetRadiation', 'Precip', 'Inflow', 'Outflow',
            'WindSpeed', 'DevelopedArea', 'AgricultureArea']
X = df[all_vars].values

scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# PCA on ALL variables together
fa = FactorAnalyzer(n_factors=4, rotation='varimax')
fa.fit(X_scaled)
scores = fa.transform(X_scaled)
```

2. **Interpret loadings** to map factors to categories (optional for understanding)

3. **Use factor scores directly** for R² decomposition

**Important**: Do NOT run separate PCA for each category. Run one global PCA on all variables, then use the resulting factor scores for contribution analysis.

## Interpreting Factor Loadings

Loadings show correlation between original variables and components:

| Loading | Interpretation |
|---------|----------------|
| > 0.7 | Strong association |
| 0.4 - 0.7 | Moderate association |
| < 0.4 | Weak association |

## Example: Economic Indicators
```python
import pandas as pd
from sklearn.preprocessing import StandardScaler
from factor_analyzer import FactorAnalyzer

# Variables: gdp, unemployment, inflation, interest_rate, exports, imports
df = pd.read_csv('economic_data.csv')
variables = ['gdp', 'unemployment', 'inflation',
             'interest_rate', 'exports', 'imports']

X = df[variables].values
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

fa = FactorAnalyzer(n_factors=3, rotation='varimax')
fa.fit(X_scaled)

# View loadings
loadings_df = pd.DataFrame(
    fa.loadings_,
    index=variables,
    columns=['RC1', 'RC2', 'RC3']
)
print(loadings_df.round(2))
```

## Choosing Number of Factors

### Option 1: Kaiser Criterion
```python
# Check eigenvalues
eigenvalues, _ = fa.get_eigenvalues()

# Keep factors with eigenvalue > 1
n_factors = sum(eigenvalues > 1)
```

### Option 2: Domain Knowledge

If you know how many categories your variables should group into, specify directly:
```python
# Example: health data with 3 expected categories (lifestyle, genetics, environment)
fa = FactorAnalyzer(n_factors=3, rotation='varimax')
```

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Loadings all similar | Too few factors | Increase n_factors |
| Negative loadings | Inverse relationship | Normal, interpret direction |
| Low variance explained | Data not suitable for PCA | Check correlations first |

## Best Practices

- Always standardize data before PCA
- Use varimax rotation for interpretability
- Check factor loadings to name components
- Use Kaiser criterion or domain knowledge for n_factors
- For attribution analysis, run ONE global PCA on all variables
