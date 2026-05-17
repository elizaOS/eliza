---
name: exoplanet-workflows
description: General workflows and best practices for exoplanet detection and characterization from light curve data. Use when planning an exoplanet analysis pipeline, understanding when to use different methods, or troubleshooting detection issues.
---

# Exoplanet Detection Workflows

This skill provides general guidance on exoplanet detection workflows, helping you choose the right approach for your data and goals.

## Overview

Exoplanet detection from light curves typically involves:
1. Data loading and quality control
2. Preprocessing to remove instrumental and stellar noise
3. Period search using appropriate algorithms
4. Signal validation and characterization
5. Parameter estimation

## Pipeline Design Principles

### Key Stages

1. **Data Loading**: Understand your data format, columns, time system
2. **Quality Control**: Filter bad data points using quality flags
3. **Preprocessing**: Remove noise while preserving planetary signals
4. **Period Search**: Choose appropriate algorithm for signal type
5. **Validation**: Verify candidate is real, not artifact
6. **Refinement**: Improve period precision if candidate is strong

### Critical Decisions

**What to preprocess?**
- Remove outliers? Yes, but not too aggressively
- Remove trends? Yes, stellar rotation masks transits
- How much? Balance noise removal vs. signal preservation

**Which period search algorithm?**
- **TLS**: Best for transit-shaped signals (box-like dips)
- **Lomb-Scargle**: Good for any periodic signal, fast exploration
- **BLS**: Alternative to TLS, built into Astropy

**What period range to search?**
- Consider target star type and expected planet types
- Hot Jupiters: short periods (0.5-10 days)
- Habitable zone: longer periods (depends on star)
- Balance: wider range = more complete, but slower

**When to refine?**
- After finding promising candidate
- Narrow search around candidate period
- Improves precision for final measurement

## Choosing the Right Method

### Transit Least Squares (TLS)
**Use when:**
- Searching for transiting exoplanets
- Signal has transit-like shape (box-shaped dips)
- You have flux uncertainties

**Advantages:**
- Most sensitive for transits
- Handles grazing transits
- Provides transit parameters

**Disadvantages:**
- Slower than Lomb-Scargle
- Only detects transits (not RV planets, eclipsing binaries with non-box shapes)

### Lomb-Scargle Periodogram
**Use when:**
- Exploring data for any periodic signal
- Detecting stellar rotation
- Finding pulsation periods
- Quick period search

**Advantages:**
- Fast
- Works for any periodic signal
- Good for initial exploration

**Disadvantages:**
- Less sensitive to shallow transits
- May confuse harmonics with true period

### Box Least Squares (BLS)
**Use when:**
- Alternative to TLS for transits
- Available in astropy

**Note**: TLS generally performs better than BLS for exoplanet detection.

## Signal Validation

### Strong Candidate (TLS)
- **SDE > 9**: Very strong candidate
- **SDE > 6**: Strong candidate
- **SNR > 7**: Reliable signal

### Warning Signs
- **Low SDE (<6)**: Weak signal, may be false positive
- **Period exactly half/double expected**: Check for aliasing
- **High odd-even mismatch**: May not be planetary transit

### How to Validate

- **Signal strength metrics**: Check SDE, SNR against thresholds
- **Visual inspection**: Phase-fold data at candidate period
- **Odd-even consistency**: Do odd and even transits have same depth?
- **Multiple transits**: More transits = more confidence

## Multi-Planet Systems

Some systems have multiple transiting planets. Strategy:

1. Find first candidate
2. Mask out first planet's transits
3. Search remaining data for additional periods
4. Repeat until no more significant signals

See Transit Least Squares documentation for `transit_mask` function.

## Common Issues and Solutions

### Issue: No significant detection (low SDE)
**Solutions:**
- Check preprocessing - may be removing signal
- Try less aggressive outlier removal
- Check for data gaps during transits
- Signal may be too shallow for detection

### Issue: Period is 2x or 0.5x expected
**Causes:**
- Period aliasing from data gaps
- Missing alternate transits

**Solutions:**
- Check both periods manually
- Look at phase-folded light curves
- Check if one shows odd-even mismatch

### Issue: flux_err required error
**Solution:**
TLS requires flux uncertainties as the third argument - they're not optional!

### Issue: Results vary with preprocessing
**Diagnosis:**
- Compare results with different preprocessing
- Plot each preprocessing step
- Ensure you're not over-smoothing

## Expected Transit Depths

For context:
- **Hot Jupiters**: 0.01-0.03 (1-3% dip)
- **Super-Earths**: 0.001-0.003 (0.1-0.3% dip)
- **Earth-sized**: 0.0001-0.001 (0.01-0.1% dip)

Detection difficulty increases dramatically for smaller planets.

## Period Range Guidelines

Based on target characteristics:
- **Hot Jupiters**: 0.5-10 days
- **Warm planets**: 10-100 days
- **Habitable zone**:
  - Sun-like star: 200-400 days
  - M-dwarf: 10-50 days

Adjust search ranges based on mission duration and expected planet types.

## Best Practices

1. **Always include flux uncertainties** - critical for proper weighting
2. **Visualize each preprocessing step** - ensure you're improving data quality
3. **Check quality flags** - verify convention (flag=0 may mean good OR bad)
4. **Use appropriate sigma** - 3 for initial outliers, 5 after flattening
5. **Refine promising candidates** - narrow period search for precision
6. **Validate detections** - check SDE, SNR, phase-folded plots
7. **Consider data gaps** - may cause period aliasing
8. **Document your workflow** - reproducibility is key

## References

### Official Documentation
- [Lightkurve Tutorials](https://lightkurve.github.io/lightkurve/tutorials/index.html)
- [TLS GitHub](https://github.com/hippke/tls)
- [TLS Tutorials](https://github.com/hippke/tls/tree/master/tutorials)

### Key Papers
- Hippke & Heller (2019) - Transit Least Squares paper
- Kovács et al. (2002) - BLS algorithm

### Lightkurve Tutorial Sections
- Section 3.1: Identifying transiting exoplanet signals
- Section 2.3: Removing instrumental noise
- Section 3.2: Creating periodograms

## Dependencies

```bash
pip install lightkurve transitleastsquares numpy matplotlib scipy
```
