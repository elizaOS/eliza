# P9: Thanksgiving Dinner with Disruptions Dataset

## Overview
This dataset extends P6 with flight delays and recovery windows for meal and guest coordination.

## Data Sources
- **Weather APIs**: Weather impact data for flight delays
- **Transit APIs**: Multi-modal disruption data
- **Synthetic Generation**: Flight delay scenarios

## Dataset Structure
```
P9/
├── flight_delays/    # Flight delay scenarios
├── weather/          # Weather impact data
├── disruptions/      # Processed disruption instances
└── README.md         # This file
```

## Data Format
Each instance extends P6 format with:
- **Flight Delays**: Delayed arrivals with recovery windows
- **Meal Adjustments**: Cooking schedule adaptations
- **Guest Coordination**: Updated pickup and preparation schedules

## Download Instructions

### Option 1: Use Weather APIs
```bash
# Weather API (requires API key)
# Visit: https://openweathermap.org/api
```

### Option 2: Generate Disruption Scenarios
```bash
python generate_thanksgiving_disruptions.py --base_dataset P6/custom/ --output disruptions/
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

