# P4: URS with Disruptions Dataset

## Overview
This dataset extends P3 with traffic delays, road closures, and dynamic disruptions.

## Data Sources
- **NYC Traffic Data**: Real-time traffic incidents and delays
- **Chicago Traffic Incidents**: Road closures and accidents
- **BTS Airline Delays**: Flight delay patterns for disruption modeling

## Dataset Structure
```
P4/
├── traffic_incidents/   # Traffic incident data
├── road_closures/       # Road closure events
├── disruptions/         # Processed disruption scenarios
└── README.md           # This file
```

## Data Format
Each instance extends P3 format with:
- **Disruptions**: Traffic delays, road closures with duration/impact
- **Dynamic Updates**: Real-time changes to route feasibility
- **Recovery Strategies**: Alternative routes and contingency plans

## Download Instructions

### Option 1: Download NYC Traffic Data
```bash
# NYC Traffic Incidents
wget https://data.cityofnewyork.us/api/views/h9gi-nx95/rows.csv -O nyc_traffic.csv
```

### Option 2: Download Chicago Traffic Data
```bash
# Chicago Traffic Crashes
wget https://data.cityofchicago.org/api/views/85ca-t3if/rows.csv -O chicago_traffic.csv
```

### Option 3: Generate Disruption Scenarios
```bash
python generate_disruption_scenarios.py --base_dataset P3/processed/ --output disruptions/
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

