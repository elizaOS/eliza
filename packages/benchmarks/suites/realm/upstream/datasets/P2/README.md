# P2: Multi-Group Campus Tours Dataset

## Overview
This dataset contains instances for multi-group campus tour scheduling problems with multiple tour guides and visitor groups.

## Data Sources
- **Solomon VRP**: Vehicle Routing Problem with Time Windows instances
- **Gehring & Homberger**: Extended VRP instances
- **Custom Generated**: Multi-group tour scenarios

## Dataset Structure
```
P2/
├── solomon/         # Solomon VRP-TW instances
├── gehring/         # Gehring & Homberger instances
├── custom/          # Custom generated multi-group scenarios
└── README.md        # This file
```

## Data Format
Each instance contains:
- **Visitor Groups**: List of groups with sizes and preferred times
- **Tour Guides**: Available guides with availability windows
- **Constraints**: Maximum group size per guide, tour duration limits
- **Objectives**: Minimize wait times, balance workload

## Download Instructions

### Option 1: Download Solomon Instances
```bash
# Download Solomon VRP instances
wget http://web.cba.neu.edu/~msolomon/problems.htm -O solomon_problems.html
# Extract and download individual instance files
```

### Option 2: Download Gehring & Homberger Instances
```bash
# Download from Gehring & Homberger dataset
wget http://www.bernabe.dorronsoro.es/vrp/ -r -np -nH --cut-dirs=2 -A "*.txt"
```

### Option 3: Generate Custom Instances
```bash
python generate_multi_group_instances.py --num_instances 100
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

