---
name: scipy-curve-fit
description: Use scipy.optimize.curve_fit for nonlinear least squares parameter estimation from experimental data.
---

# Using scipy.optimize.curve_fit for Parameter Estimation

## Overview

`scipy.optimize.curve_fit` is a tool for fitting models to experimental data using nonlinear least squares optimization.

## Basic Usage

```python
from scipy.optimize import curve_fit
import numpy as np

# Define your model function
def model(x, param1, param2):
    return param1 * (1 - np.exp(-x / param2))

# Fit to data
popt, pcov = curve_fit(model, x_data, y_data)

# popt contains the optimal parameters [param1, param2]
# pcov contains the covariance matrix
```

## Fitting a First-Order Step Response

```python
import numpy as np
from scipy.optimize import curve_fit

# Known values from experiment
y_initial = ...  # Initial output value
u = ...          # Input magnitude during step test

# Define the step response model
def step_response(t, K, tau):
    """First-order step response with fixed initial value and input."""
    return y_initial + K * u * (1 - np.exp(-t / tau))

# Your experimental data
t_data = np.array([...])  # Time points
y_data = np.array([...])  # Output readings

# Perform the fit
popt, pcov = curve_fit(
    step_response,
    t_data,
    y_data,
    p0=[K_guess, tau_guess],      # Initial guesses
    bounds=([K_min, tau_min], [K_max, tau_max])  # Parameter bounds
)

K_estimated, tau_estimated = popt
```

## Setting Initial Guesses (p0)

Good initial guesses speed up convergence:

```python
# Estimate K from steady-state data
K_guess = (y_data[-1] - y_initial) / u

# Estimate tau from 63.2% rise time
y_63 = y_initial + 0.632 * (y_data[-1] - y_initial)
idx_63 = np.argmin(np.abs(y_data - y_63))
tau_guess = t_data[idx_63]

p0 = [K_guess, tau_guess]
```

## Setting Parameter Bounds

Bounds prevent physically impossible solutions:

```python
bounds = (
    [lower_K, lower_tau],    # Lower bounds
    [upper_K, upper_tau]     # Upper bounds
)
```

## Calculating Fit Quality

### R-squared (Coefficient of Determination)

```python
# Predicted values from fitted model
y_predicted = step_response(t_data, K_estimated, tau_estimated)

# Calculate R-squared
ss_residuals = np.sum((y_data - y_predicted) ** 2)
ss_total = np.sum((y_data - np.mean(y_data)) ** 2)
r_squared = 1 - (ss_residuals / ss_total)
```

### Root Mean Square Error (RMSE)

```python
residuals = y_data - y_predicted
rmse = np.sqrt(np.mean(residuals ** 2))
```

## Complete Example

```python
import numpy as np
from scipy.optimize import curve_fit

def fit_first_order_model(data, y_initial, input_value):
    """
    Fit first-order model to step response data.

    Returns dict with K, tau, r_squared, fitting_error
    """
    t_data = np.array([d["time"] for d in data])
    y_data = np.array([d["output"] for d in data])

    def model(t, K, tau):
        return y_initial + K * input_value * (1 - np.exp(-t / tau))

    # Initial guesses
    K_guess = (y_data[-1] - y_initial) / input_value
    tau_guess = t_data[len(t_data)//3]  # Rough guess

    # Fit with bounds
    popt, _ = curve_fit(
        model, t_data, y_data,
        p0=[K_guess, tau_guess],
        bounds=([0, 0], [np.inf, np.inf])
    )

    K, tau = popt

    # Calculate quality metrics
    y_pred = model(t_data, K, tau)
    ss_res = np.sum((y_data - y_pred) ** 2)
    ss_tot = np.sum((y_data - np.mean(y_data)) ** 2)
    r_squared = 1 - (ss_res / ss_tot)
    fitting_error = np.sqrt(np.mean((y_data - y_pred) ** 2))

    return {
        "K": float(K),
        "tau": float(tau),
        "r_squared": float(r_squared),
        "fitting_error": float(fitting_error)
    }
```

## Common Issues

1. **RuntimeError**: Optimal parameters not found
   - Try better initial guesses
   - Check that data is valid (no NaN, reasonable range)

2. **Poor fit (low R^2)**:
   - Data might not be from step response phase
   - System might not be first-order
   - Too much noise in measurements

3. **Unrealistic parameters**:
   - Add bounds to constrain solution
   - Check units are consistent
