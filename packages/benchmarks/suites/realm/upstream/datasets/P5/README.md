# P5: Wedding Logistics Dataset

## Overview
This dataset contains instances for wedding logistics coordination including guest arrivals, errands, and shared vehicle usage.

## Data Sources
- **Airport Traffic Data**: BTS airport arrival/departure data
- **Event Planning Templates**: Custom wedding logistics scenarios
- **Synthetic Generation**: Generated coordination scenarios

## Dataset Structure
```
P5/
├── airport_data/     # Airport pickup schedules
├── templates/        # Wedding logistics templates
├── custom/           # Generated instances
└── README.md         # This file
```

## Data Format
Each instance contains:
- **Locations**: Airport, gift shop, tailor, wedding venue
- **Guest Arrivals**: Flight schedules and pickup requirements
- **Errands**: Tasks with dependencies and deadlines
- **Vehicles**: Available vehicles with capacity constraints

## Download Instructions

### Option 1: Download BTS Airport Data
```bash
# BTS Airport Traffic Data
# Visit: https://www.transtats.bts.gov/
# Download flight arrival/departure data
```

### Option 2: Generate Custom Instances
```bash
python generate_wedding_instances.py --num_instances 100
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

