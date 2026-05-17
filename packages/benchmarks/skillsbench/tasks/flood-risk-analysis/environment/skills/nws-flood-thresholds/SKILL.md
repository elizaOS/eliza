---
name: nws-flood-thresholds
description: Download flood stage thresholds from NWS (National Weather Service). Use when determining flood levels for USGS stations, accessing action/minor/moderate/major flood stages, or matching stations to their flood thresholds.
license: MIT
---

# NWS Flood Thresholds Guide

## Overview

The National Weather Service (NWS) maintains flood stage thresholds for thousands of stream gages across the United States. These thresholds define when water levels become hazardous.

## Data Sources

### Option 1: Bulk CSV Download (Recommended for Multiple Stations)
```
https://water.noaa.gov/resources/downloads/reports/nwps_all_gauges_report.csv
```

### Option 2: Individual Station Pages
```
https://water.noaa.gov/gauges/<station_id>
```

Example: `https://water.noaa.gov/gauges/04118105`

## Flood Stage Categories

| Category | CSV Column | Description |
|----------|------------|-------------|
| Action Stage | `action stage` | Water level requiring monitoring, preparation may be needed |
| **Flood Stage (Minor)** | **`flood stage`** | **Minimal property damage, some public threat. Use this to determine if flooding occurred.** |
| Moderate Flood Stage | `moderate flood stage` | Structure inundation, evacuations may be needed |
| Major Flood Stage | `major flood stage` | Extensive damage, significant evacuations required |

For general flood detection, use the `flood stage` column as the threshold.

## Downloading Bulk CSV
```python
import pandas as pd
import csv
import urllib.request
import io

nws_url = "https://water.noaa.gov/resources/downloads/reports/nwps_all_gauges_report.csv"

response = urllib.request.urlopen(nws_url)
content = response.read().decode('utf-8')
reader = csv.reader(io.StringIO(content))
headers = next(reader)
data = [row[:43] for row in reader]  # Truncate to 43 columns
nws_df = pd.DataFrame(data, columns=headers)
```

## Important: CSV Column Mismatch

The NWS CSV has a known issue: header row has 43 columns but data rows have 44 columns. Always truncate data rows to match header count:
```python
data = [row[:43] for row in reader]
```

## Key Columns

| Column Name | Description |
|-------------|-------------|
| `usgs id` | USGS station ID (8-digit string) |
| `location name` | Station name/location |
| `state` | Two-letter state code |
| `action stage` | Action threshold (feet) |
| `flood stage` | Minor flood threshold (feet) |
| `moderate flood stage` | Moderate flood threshold (feet) |
| `major flood stage` | Major flood threshold (feet) |

## Converting to Numeric

Threshold columns need conversion from strings:
```python
nws_df['flood stage'] = pd.to_numeric(nws_df['flood stage'], errors='coerce')
```

## Filtering by State
```python
# Get stations for a specific state
state_stations = nws_df[
    (nws_df['state'] == '<STATE_CODE>') &
    (nws_df['usgs id'].notna()) &
    (nws_df['usgs id'] != '') &
    (nws_df['flood stage'].notna()) &
    (nws_df['flood stage'] != -9999)
]
```

## Matching Thresholds to Station IDs
```python
# Build a dictionary of station thresholds
station_ids = ['<id_1>', '<id_2>', '<id_3>']
thresholds = {}

for _, row in nws_df.iterrows():
    usgs_id = str(row['usgs id']).strip()
    if usgs_id in station_ids:
        thresholds[usgs_id] = {
            'name': row['location name'],
            'flood': row['flood stage']
        }
```

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Column mismatch error | CSV has 44 data columns but 43 headers | Truncate rows to 43 columns |
| Missing thresholds | Station not in NWS database | Skip station or use alternative source |
| Value is -9999 | No threshold defined | Filter out these values |
| Empty usgs id | NWS-only station | Filter by `usgs id != ''` |

## Best Practices

- Always truncate CSV rows to match header count
- Convert threshold columns to numeric before comparison
- Filter out -9999 values (indicates no threshold defined)
- Match stations by USGS ID (8-digit string with leading zeros)
- Some stations may have flood stage but not action/moderate/major
