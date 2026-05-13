---
name: simulation-metrics
description: Use this skill when calculating control system performance metrics such as rise time, overshoot percentage, steady-state error, or settling time for evaluating simulation results.
---

# Control System Performance Metrics

## Rise Time

Time for system to go from 10% to 90% of target value.

```python
def rise_time(times, values, target):
    """Calculate rise time (10% to 90% of target)."""
    t10 = t90 = None

    for t, v in zip(times, values):
        if t10 is None and v >= 0.1 * target:
            t10 = t
        if t90 is None and v >= 0.9 * target:
            t90 = t
            break

    if t10 is not None and t90 is not None:
        return t90 - t10
    return None
```

## Overshoot

How much response exceeds target, as percentage.

```python
def overshoot_percent(values, target):
    """Calculate overshoot percentage."""
    max_val = max(values)
    if max_val <= target:
        return 0.0
    return ((max_val - target) / target) * 100
```

## Steady-State Error

Difference between target and final settled value.

```python
def steady_state_error(values, target, final_fraction=0.1):
    """Calculate steady-state error using final portion of data."""
    n = len(values)
    start = int(n * (1 - final_fraction))
    final_avg = sum(values[start:]) / len(values[start:])
    return abs(target - final_avg)
```

## Settling Time

Time to stay within tolerance band of target.

```python
def settling_time(times, values, target, tolerance=0.02):
    """Time to settle within tolerance of target."""
    band = target * tolerance
    lower, upper = target - band, target + band

    settled_at = None
    for t, v in zip(times, values):
        if v < lower or v > upper:
            settled_at = None
        elif settled_at is None:
            settled_at = t

    return settled_at
```

## Usage

```python
times = [row['time'] for row in results]
values = [row['value'] for row in results]
target = 30.0

print(f"Rise time: {rise_time(times, values, target)}")
print(f"Overshoot: {overshoot_percent(values, target)}%")
print(f"SS Error: {steady_state_error(values, target)}")
```
