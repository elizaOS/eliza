---
name: box-least-squares
description: Box Least Squares (BLS) periodogram for detecting transiting exoplanets and eclipsing binaries. Use when searching for periodic box-shaped dips in light curves. Alternative to Transit Least Squares, available in astropy.timeseries. Based on Kovács et al. (2002).
---

# Box Least Squares (BLS) Periodogram

The Box Least Squares (BLS) periodogram is a statistical tool for detecting transiting exoplanets and eclipsing binaries in photometric time series data. BLS models a transit as a periodic upside-down top hat (box shape) and finds the period, duration, depth, and reference time that best fit the data.

## Overview

BLS is built into Astropy and provides an alternative to Transit Least Squares (TLS). Both search for transits, but with different implementations and performance characteristics.

**Key parameters BLS searches for:**
- Period (orbital period)
- Duration (transit duration)
- Depth (how much flux drops during transit)
- Reference time (mid-transit time of first transit)

## Installation

BLS is part of Astropy:

```bash
pip install astropy
```

## Basic Usage

```python
import numpy as np
import astropy.units as u
from astropy.timeseries import BoxLeastSquares

# Prepare data
# time, flux, and flux_err should be numpy arrays or Quantities
t = time * u.day  # Add units if not already present
y = flux
dy = flux_err  # Optional but recommended

# Create BLS object
model = BoxLeastSquares(t, y, dy=dy)

# Automatic period search with specified duration
duration = 0.2 * u.day  # Expected transit duration
periodogram = model.autopower(duration)

# Extract results
best_period = periodogram.period[np.argmax(periodogram.power)]
print(f"Best period: {best_period:.5f}")
```

## Using autopower vs power

### autopower: Automatic Period Grid

Recommended for initial searches. Automatically determines appropriate period grid:

```python
# Specify duration (or multiple durations)
duration = 0.2 * u.day
periodogram = model.autopower(duration)

# Or search multiple durations
durations = [0.1, 0.15, 0.2, 0.25] * u.day
periodogram = model.autopower(durations)
```

### power: Custom Period Grid

For more control over the search:

```python
# Define custom period grid
periods = np.linspace(2.0, 10.0, 1000) * u.day
duration = 0.2 * u.day

periodogram = model.power(periods, duration)
```

**Warning**: Period grid quality matters! Too coarse and you'll miss the true period.

## Objective Functions

BLS supports two objective functions:

### 1. Log Likelihood (default)

Maximizes the statistical likelihood of the model fit:

```python
periodogram = model.autopower(0.2 * u.day, objective='likelihood')
```

### 2. Signal-to-Noise Ratio (SNR)

Uses the SNR with which the transit depth is measured:

```python
periodogram = model.autopower(0.2 * u.day, objective='snr')
```

The SNR objective can improve reliability in the presence of correlated noise.

## Complete Example

```python
import numpy as np
import matplotlib.pyplot as plt
import astropy.units as u
from astropy.timeseries import BoxLeastSquares

# Load and prepare data
data = np.loadtxt('light_curve.txt')
time = data[:, 0] * u.day
flux = data[:, 1]
flux_err = data[:, 3]

# Create BLS model
model = BoxLeastSquares(time, flux, dy=flux_err)

# Run BLS with automatic period grid
# Try multiple durations to find best fit
durations = np.linspace(0.05, 0.3, 10) * u.day
periodogram = model.autopower(durations, objective='likelihood')

# Find peak
max_power_idx = np.argmax(periodogram.power)
best_period = periodogram.period[max_power_idx]
best_duration = periodogram.duration[max_power_idx]
best_t0 = periodogram.transit_time[max_power_idx]
max_power = periodogram.power[max_power_idx]

print(f"Period: {best_period:.5f}")
print(f"Duration: {best_duration:.5f}")
print(f"T0: {best_t0:.5f}")
print(f"Power: {max_power:.2f}")

# Plot periodogram
import matplotlib.pyplot as plt
plt.plot(periodogram.period, periodogram.power)
plt.xlabel('Period [days]')
plt.ylabel('BLS Power')
plt.show()
```

## Peak Statistics for Validation

Use `compute_stats()` to calculate detailed statistics about a candidate transit:

```python
# Get statistics for the best period
stats = model.compute_stats(
    periodogram.period[max_power_idx],
    periodogram.duration[max_power_idx],
    periodogram.transit_time[max_power_idx]
)

# Key statistics for validation
print(f"Depth: {stats['depth']:.6f}")
print(f"Depth uncertainty: {stats['depth_err']:.6f}")
print(f"SNR: {stats['depth_snr']:.2f}")
print(f"Odd/Even mismatch: {stats['depth_odd'] - stats['depth_even']:.6f}")
print(f"Number of transits: {stats['transit_count']}")

# Check for false positives
if abs(stats['depth_odd'] - stats['depth_even']) > 3 * stats['depth_err']:
    print("Warning: Significant odd-even mismatch - may not be planetary")
```

**Validation criteria:**
- **High depth SNR (>7)**: Strong signal
- **Low odd-even mismatch**: Consistent transit depth
- **Multiple transits observed**: More reliable
- **Reasonable duration**: Not too long or too short for orbit

## Period Grid Sensitivity

The BLS periodogram is sensitive to period grid spacing. The `autoperiod()` method provides a conservative grid:

```python
# Get automatic period grid
periods = model.autoperiod(durations, minimum_period=1*u.day, maximum_period=10*u.day)
print(f"Period grid has {len(periods)} points")

# Use this grid with power()
periodogram = model.power(periods, durations)
```

**Tips:**
- Use `autopower()` for initial searches
- Use finer grids around promising candidates
- Period grid quality matters more for BLS than for Lomb-Scargle

## Comparing BLS Results

To compare multiple peaks:

```python
# Find top 5 peaks
sorted_idx = np.argsort(periodogram.power)[::-1]
top_5 = sorted_idx[:5]

print("Top 5 candidates:")
for i, idx in enumerate(top_5):
    period = periodogram.period[idx]
    power = periodogram.power[idx]
    duration = periodogram.duration[idx]

    stats = model.compute_stats(period, duration, periodogram.transit_time[idx])

    print(f"\n{i+1}. Period: {period:.5f}")
    print(f"   Power: {power:.2f}")
    print(f"   Duration: {duration:.5f}")
    print(f"   SNR: {stats['depth_snr']:.2f}")
    print(f"   Transits: {stats['transit_count']}")
```

## Phase-Folded Light Curve

After finding a candidate, phase-fold to visualize the transit:

```python
# Fold the light curve at the best period
phase = ((time.value - best_t0.value) % best_period.value) / best_period.value

# Plot to verify transit shape
import matplotlib.pyplot as plt
plt.plot(phase, flux, '.')
plt.xlabel('Phase')
plt.ylabel('Flux')
plt.show()
```

## BLS vs Transit Least Squares (TLS)

Both methods search for transits, but differ in implementation:

### Box Least Squares (BLS)
**Pros:**
- Built into Astropy (no extra install)
- Fast for targeted searches
- Good statistical framework
- compute_stats() provides detailed validation

**Cons:**
- Simpler transit model (box shape)
- Requires careful period grid setup
- May be less sensitive to grazing transits

### Transit Least Squares (TLS)
**Pros:**
- More sophisticated transit models
- Generally more sensitive
- Better handles grazing transits
- Automatic period grid is more robust

**Cons:**
- Requires separate package
- Slower for very long time series
- Less control over transit shape

**Recommendation**: Try both! TLS is often more sensitive, but BLS is faster and built-in.

## Integration with Preprocessing

BLS works best with preprocessed data. Consider this pipeline:

1. **Quality filtering**: Remove flagged data points
2. **Outlier removal**: Clean obvious artifacts
3. **Detrending**: Remove stellar variability (rotation, trends)
4. **BLS search**: Run period search on cleaned data
5. **Validation**: Use `compute_stats()` to check candidate quality

### Key Considerations

- Preprocessing should **preserve transit shapes** (use gentle methods like `flatten()`)
- Don't over-process - too aggressive cleaning removes real signals
- BLS needs reasonable period and duration ranges
- Always validate with multiple metrics (power, SNR, odd-even)

## Common Issues

### Issue: No clear peak
**Causes:**
- Transits too shallow
- Wrong duration range
- Period outside search range
- Over-aggressive preprocessing

**Solutions:**
- Try wider duration range
- Extend period search range
- Use less aggressive `flatten()` window
- Check raw data for transits

### Issue: Period is 2× or 0.5× expected
**Causes:**
- Missing alternating transits
- Data gaps
- Period aliasing

**Solutions:**
- Check both periods manually
- Examine odd-even statistics
- Look at phase-folded plots for both periods

### Issue: High odd-even mismatch
**Cause:**
- Not a planetary transit
- Eclipsing binary
- Instrumental artifact

**Solution:**
- Check `stats['depth_odd']` vs `stats['depth_even']`
- May not be a transiting planet

## Dependencies

```bash
pip install astropy numpy matplotlib
# Optional: lightkurve for preprocessing
pip install lightkurve
```

## References

### Official Documentation
- [Astropy BLS Documentation](https://docs.astropy.org/en/stable/timeseries/bls.html)
- [Astropy Time Series Guide](https://docs.astropy.org/en/stable/timeseries/)

### Key Papers
- **Kovács, Zucker, & Mazeh (2002)**: Original BLS paper - [A&A 391, 369](https://arxiv.org/abs/astro-ph/0206099)
- **Hartman & Bakos (2016)**: VARTOOLS implementation - [A&C 17, 1](https://arxiv.org/abs/1605.06811)

### Related Resources
- [Lightkurve Tutorials](https://lightkurve.github.io/lightkurve/tutorials/)
- [TLS GitHub](https://github.com/hippke/tls) - Alternative transit detection method

## When to Use BLS

**Use BLS when:**
- You want a fast, built-in solution
- You need detailed validation statistics (`compute_stats`)
- Working within the Astropy ecosystem
- You want fine control over period grid

**Use TLS when:**
- Maximum sensitivity is critical
- Dealing with grazing or partial transits
- Want automatic robust period grid
- Prefer more sophisticated transit models

**Use Lomb-Scargle when:**
- Searching for general periodic signals (not specifically transits)
- Detecting stellar rotation, pulsation
- Initial exploration of periodicity

For exoplanet detection, both BLS and TLS are valid choices. Try both and compare results!
