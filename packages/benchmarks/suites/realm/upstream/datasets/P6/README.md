# P6: Thanksgiving Dinner Planning Dataset

## Overview
This dataset contains instances for coordinating family travel and meal preparation with dependencies.

## Data Sources
- **BTS Airport Data**: Flight schedules for family arrivals
- **Recipe APIs**: Cooking time data for meal preparation
- **Synthetic Generation**: Family coordination scenarios

## Dataset Structure
```
P6/
├── airport_data/     # Flight arrival schedules
├── recipes/          # Cooking time data
├── custom/           # Generated instances
└── README.md         # This file
```

## Data Format
Each instance contains:
- **Family Members**: Arrival times, cooking skills, flight information
- **Cooking Tasks**: Dependencies, preparation times, kitchen capacity
- **Vehicles**: For airport pickups and coordination
- **Deadlines**: Dinner serving time and preparation windows

## Download Instructions

### Option 1: Download BTS Airport Data
```bash
# BTS Airport Data
# Visit: https://www.transtats.bts.gov/Tables.asp?QO_VQ=EFD
```

### Option 2: Generate Custom Instances
```bash
python generate_thanksgiving_instances.py --num_instances 100
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

