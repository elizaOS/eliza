# P1: Single-Agent Campus Tour Dataset

## Overview
This dataset contains instances for single-agent campus tour planning problems with time windows and spatial constraints.

## Data Sources
- **TSPLIB**: Standard TSP instances adapted for campus tours
- **Custom Campus Layouts**: Generated campus maps with locations and time windows

## Dataset Structure
```
P1/
├── tsplib/          # TSPLIB instances adapted for campus tours
├── custom/          # Custom generated campus layouts
└── README.md        # This file
```

## Data Format
Each instance contains:
- **Locations**: List of campus locations (library, cafeteria, gym, student_center, entrance)
- **Distances**: Travel times between locations (in minutes)
- **Time Windows**: Available time windows for each location
- **Constraints**: Maximum tour duration, start/end locations

## Download Instructions

### Option 1: Download TSPLIB Instances
```bash
# Download TSPLIB instances
wget http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/tsp/ -r -np -nH --cut-dirs=2 -A "*.tsp"
```

### Option 2: Generate Custom Instances
```bash
python generate_campus_instances.py --num_instances 100
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

