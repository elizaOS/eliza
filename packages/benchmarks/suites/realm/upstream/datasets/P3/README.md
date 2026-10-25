# P3: Urban Ride-Sharing (URS) Dataset

## Overview
This dataset contains real-world ride-sharing trip data for urban vehicle routing optimization.

## Data Sources
- **NYC Taxi Trip Data**: Real taxi trip records from New York City
- **Chicago Taxi Data**: Real taxi trip records from Chicago
- **Uber Movement Data**: Aggregated travel time data

## Dataset Structure
```
P3/
├── nyc_taxi/        # NYC Taxi Trip Data (CSV)
├── chicago_taxi/    # Chicago Taxi Data (CSV)
├── uber_movement/   # Uber Movement travel times
├── processed/       # Processed instances for evaluation
└── README.md        # This file
```

## Data Format
Each instance contains:
- **City Map**: Graph of locations and roads with distances/travel times
- **Ride Requests**: Passenger pickup/dropoff locations with time windows
- **Vehicles**: Available vehicles with capacity, location, fuel level

## Download Instructions

### Option 1: Download NYC Taxi Data
```bash
# NYC Taxi Trip Data (requires API key or direct download)
# Visit: https://www1.nyc.gov/site/tlc/about/tlc-trip-record-data.page
# Download monthly trip data files
```

### Option 2: Download Chicago Taxi Data
```bash
# Chicago Taxi Data
wget https://data.cityofchicago.org/api/views/wrvz-psew/rows.csv?accessType=DOWNLOAD -O chicago_taxi.csv
```

### Option 3: Process Raw Data
```bash
python process_taxi_data.py --source nyc --output processed/
python process_taxi_data.py --source chicago --output processed/
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

