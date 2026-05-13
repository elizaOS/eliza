---
name: usgs-data-download
description: Download water level data from USGS using the dataretrieval package. Use when accessing real-time or historical streamflow data, downloading gage height or discharge measurements, or working with USGS station IDs.
license: MIT
---

# USGS Data Download Guide

## Overview

This guide covers downloading water level data from USGS using the `dataretrieval` Python package. USGS maintains thousands of stream gages across the United States that record water levels at 15-minute intervals.

## Installation
```bash
pip install dataretrieval
```

## nwis Module (Recommended)

The NWIS module is reliable and straightforward for accessing gage height data.
```python
from dataretrieval import nwis

# Get instantaneous values (15-min intervals)
df, meta = nwis.get_iv(
    sites='<station_id>',
    start='<start_date>',
    end='<end_date>',
    parameterCd='00065'
)

# Get daily values
df, meta = nwis.get_dv(
    sites='<station_id>',
    start='<start_date>',
    end='<end_date>',
    parameterCd='00060'
)

# Get site information
info, meta = nwis.get_info(sites='<station_id>')
```

## Parameter Codes

| Code | Parameter | Unit | Description |
|------|-----------|------|-------------|
| `00065` | Gage height | feet | Water level above datum |
| `00060` | Discharge | cfs | Streamflow volume |

## nwis Module Functions

| Function | Description | Data Frequency |
|----------|-------------|----------------|
| `nwis.get_iv()` | Instantaneous values | ~15 minutes |
| `nwis.get_dv()` | Daily values | Daily |
| `nwis.get_info()` | Site information | N/A |
| `nwis.get_stats()` | Statistical summaries | N/A |
| `nwis.get_peaks()` | Annual peak discharge | Annual |

## Returned DataFrame Structure

The DataFrame has a datetime index and these columns:

| Column | Description |
|--------|-------------|
| `site_no` | Station ID |
| `00065` | Water level value |
| `00065_cd` | Quality code (can ignore) |

## Downloading Multiple Stations
```python
from dataretrieval import nwis

station_ids = ['<id_1>', '<id_2>', '<id_3>']
all_data = {}

for site_id in station_ids:
    try:
        df, meta = nwis.get_iv(
            sites=site_id,
            start='<start_date>',
            end='<end_date>',
            parameterCd='00065'
        )
        if len(df) > 0:
            all_data[site_id] = df
    except Exception as e:
        print(f"Failed to download {site_id}: {e}")

print(f"Successfully downloaded: {len(all_data)} stations")
```

## Extracting the Value Column
```python
# Find the gage height column (excludes quality code column)
gage_col = [c for c in df.columns if '00065' in str(c) and '_cd' not in str(c)]

if gage_col:
    water_levels = df[gage_col[0]]
    print(water_levels.head())
```

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Empty DataFrame | Station has no data for date range | Try different dates or use `get_iv()` |
| `get_dv()` returns empty | No daily gage height data | Use `get_iv()` and aggregate |
| Connection error | Network issue | Wrap in try/except, retry |
| Rate limited | Too many requests | Add delays between requests |

## Best Practices

- Always wrap API calls in try/except for failed downloads
- Check `len(df) > 0` before processing
- Station IDs are 8-digit strings with leading zeros (e.g., '04119000')
- Use `get_iv()` for gage height, as daily data is often unavailable
- Filter columns to exclude quality code columns (`_cd`)
- Break up large requests into smaller time periods to avoid timeouts
