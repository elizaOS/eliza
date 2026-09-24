# P7: Disaster Relief Deployment Dataset

## Overview
This dataset contains instances for disaster relief resource allocation under uncertainty.

## Data Sources
- **UN OCHA Datasets**: Humanitarian response data
- **FEMA Disaster Data**: Emergency management records
- **Humanitarian OSM**: Geographic disaster response data

## Dataset Structure
```
P7/
├── un_ocha/          # UN OCHA disaster response data
├── fema/             # FEMA disaster records
├── processed/        # Processed instances
└── README.md         # This file
```

## Data Format
Each instance contains:
- **Affected Regions**: Severity levels, resource needs, response deadlines
- **Available Resources**: Medical supplies, food, water, personnel, vehicles
- **Constraints**: Response time deadlines (critical: 2h, urgent: 6h, normal: 24h)
- **Disruptions**: Weather events, resource shortages

## Download Instructions

### Option 1: Download UN OCHA Data
```bash
# UN OCHA Humanitarian Data
# Visit: https://data.humdata.org/
# Search for disaster response datasets
```

### Option 2: Download FEMA Data
```bash
# FEMA Open Data
# Visit: https://www.fema.gov/openfema-data-page
# Download disaster declaration data
```

### Option 3: Generate Custom Instances
```bash
python generate_disaster_instances.py --num_instances 100
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

