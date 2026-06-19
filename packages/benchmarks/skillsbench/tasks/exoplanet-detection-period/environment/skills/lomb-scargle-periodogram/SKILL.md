---
name: lomb-scargle-periodogram
description: Lomb-Scargle periodogram for finding periodic signals in unevenly sampled time series data. Use when analyzing light curves, radial velocity data, or any astronomical time series to detect periodic variations. Works for stellar rotation, pulsation, eclipsing binaries, and general periodic phenomena. Based on lightkurve library.
---

# Lomb-Scargle Periodogram

The Lomb-Scargle periodogram is the standard tool for finding periods in unevenly sampled astronomical time series data. It's particularly useful for detecting periodic signals in light curves from space missions like Kepler, K2, and TESS.

## Overview

The Lomb-Scargle periodogram extends the classical periodogram to handle unevenly sampled data, which is common in astronomy due to observing constraints, data gaps, and variable cadences.

## Basic Usage with Lightkurve

```python
import lightkurve as lk
import numpy as np

# Create a light curve object
lc = lk.LightCurve(time=time, flux=flux, flux_err=error)

# Create periodogram (specify maximum period to search)
pg = lc.to_periodogram(maximum_period=15)  # Search up to 15 days

# Find strongest period
strongest_period = pg.period_at_max_power
max_power = pg.max_power

print(f"Strongest period: {strongest_period:.5f} days")
print(f"Power: {max_power:.5f}")
```

## Plotting Periodograms

```python
import matplotlib.pyplot as plt

pg.plot(view='period')  # View vs period (not frequency)
plt.xlabel('Period [days]')
plt.ylabel('Power')
plt.show()
```

**Important**: Use `view='period'` to see periods directly, not frequencies. The default `view='frequency'` shows frequency (1/period).

## Period Range Selection

Choose appropriate period ranges based on your science case:

- **Stellar rotation**: 0.1 - 100 days
- **Exoplanet transits**: 0.5 - 50 days (most common)
- **Eclipsing binaries**: 0.1 - 100 days
- **Stellar pulsations**: 0.001 - 1 day

```python
# Search specific period range
pg = lc.to_periodogram(minimum_period=2.0, maximum_period=7.0)
```

## Interpreting Results

### Power Significance

Higher power indicates stronger periodic signal, but be cautious:
- **High power**: Likely real periodic signal
- **Multiple peaks**: Could indicate harmonics (period/2, period*2)
- **Aliasing**: Very short periods may be aliases of longer periods

### Common Patterns

1. **Single strong peak**: Likely the true period
2. **Harmonics**: Peaks at period/2, period*2 suggest the fundamental period
3. **Aliases**: Check if period*2 or period/2 also show signals

## Model Fitting

Once you find a period, you can fit a model:

```python
# Get the frequency at maximum power
frequency = pg.frequency_at_max_power

# Create a model light curve
model = pg.model(time=lc.time, frequency=frequency)

# Plot data and model
import matplotlib.pyplot as plt
lc.plot(label='Data')
model.plot(label='Model')
plt.legend()
plt.show()
```

## Dependencies

```bash
pip install lightkurve numpy matplotlib
```

## References

- [Lightkurve Tutorials](https://lightkurve.github.io/lightkurve/tutorials/index.html)
- [Lightkurve Periodogram Documentation](https://docs.lightkurve.org/)

## When to Use This vs. Other Methods

- **Lomb-Scargle**: General periodic signals (rotation, pulsation, eclipsing binaries)
- **Transit Least Squares (TLS)**: Specifically for exoplanet transits (more sensitive)
- **Box Least Squares (BLS)**: Alternative transit detection method

For exoplanet detection, consider using TLS after Lomb-Scargle for initial period search.
