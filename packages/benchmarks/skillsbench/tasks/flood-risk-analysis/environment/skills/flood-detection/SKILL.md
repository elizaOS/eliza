---
name: flood-detection
description: Detect flood events by comparing water levels to thresholds. Use when determining if flooding occurred, counting flood days, aggregating instantaneous data to daily values, or classifying flood severity.
license: MIT
---

# Flood Detection Guide

## Overview

Flood detection involves comparing observed water levels against established flood stage thresholds. This guide covers how to process water level data and identify flood events.

## Flood Stage Definition

According to the National Weather Service, flood stage is the water level at which overflow of the natural banks begins to cause damage. A flood event occurs when:
```
water_level >= flood_stage_threshold
```

## Aggregating Instantaneous Data to Daily

USGS instantaneous data is recorded at ~15-minute intervals. For flood detection, aggregate to daily maximum:
```python
# df is DataFrame from nwis.get_iv() with datetime index
# gage_col is the column name containing water levels

daily_max = df[gage_col].resample('D').max()
```

### Why Daily Maximum?

| Aggregation | Use Case |
|-------------|----------|
| `max()` | Flood detection - captures peak water level |
| `mean()` | Long-term trends - may miss short flood peaks |
| `min()` | Low flow analysis |

## Detecting Flood Days

Compare daily maximum water level against flood threshold:
```python
flood_threshold = <threshold_from_nws>  # feet

# Count days with flooding
flood_days = (daily_max >= flood_threshold).sum()

# Get specific dates with flooding
flood_dates = daily_max[daily_max >= flood_threshold].index.tolist()
```

## Processing Multiple Stations
```python
flood_results = []

for site_id, site_data in all_data.items():
    daily_max = site_data['water_levels'].resample('D').max()
    threshold = thresholds[site_id]['flood']

    days_above = int((daily_max >= threshold).sum())

    if days_above > 0:
        flood_results.append({
            'station_id': site_id,
            'flood_days': days_above
        })

# Sort by flood days descending
flood_results.sort(key=lambda x: x['flood_days'], reverse=True)
```

## Flood Severity Classification

If multiple threshold levels are available:
```python
def classify_flood(water_level, thresholds):
    if water_level >= thresholds['major']:
        return 'major'
    elif water_level >= thresholds['moderate']:
        return 'moderate'
    elif water_level >= thresholds['flood']:
        return 'minor'
    elif water_level >= thresholds['action']:
        return 'action'
    else:
        return 'normal'
```

## Output Format Examples

### Simple CSV Output
```python
import csv

with open('flood_results.csv', 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['station_id', 'flood_days'])
    for result in flood_results:
        writer.writerow([result['station_id'], result['flood_days']])
```

### JSON Output
```python
import json

output = {
    'flood_events': flood_results,
    'total_stations_with_flooding': len(flood_results)
}

with open('flood_report.json', 'w') as f:
    json.dump(output, f, indent=2)
```

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No floods detected | Threshold too high or dry period | Verify threshold values |
| All days show flooding | Threshold too low or data error | Check threshold units (feet vs meters) |
| NaN in daily_max | Missing data for entire day | Check data availability |

## Best Practices

- Use daily maximum for flood detection to capture peaks
- Ensure water level and threshold use same units (typically feet)
- Only report stations with at least 1 flood day
- Sort results by flood severity or duration for prioritization
