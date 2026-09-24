# P8: Wedding Logistics with Disruptions Dataset

## Overview
This dataset extends P5 with road closures and timing conflicts requiring reactive replanning.

## Data Sources
- **BTS Airline Delays**: Flight delay data
- **Traffic Incident Data**: Road closures and traffic delays
- **Synthetic Disruptions**: Generated disruption scenarios

## Dataset Structure
```
P8/
├── disruptions/      # Road closures and delays
├── scenarios/        # Disruption scenarios
└── README.md         # This file
```

## Data Format
Each instance extends P5 format with:
- **Road Closures**: Blocked routes with duration
- **Traffic Delays**: Route-specific delays
- **Timing Conflicts**: Schedule conflicts requiring replanning

## Download Instructions

### Option 1: Download BTS Airline Delays
```bash
# BTS Airline Delays
# Visit: https://www.transtats.bts.gov/Tables.asp?QO_VQ=EFD
```

### Option 2: Generate Disruption Scenarios
```bash
python generate_wedding_disruptions.py --base_dataset P5/custom/ --output disruptions/
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

