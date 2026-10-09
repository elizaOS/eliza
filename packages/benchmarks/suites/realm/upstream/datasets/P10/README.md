# P10: Global GPU Supply Chain Dataset

## Overview
This dataset contains instances for large-scale industrial supply chain planning with procurement, infrastructure dependencies, and cost-risk tradeoffs.

## Data Sources
- **OR-Library Supply Chain**: Standard supply chain optimization instances
- **MIPLIB**: Mixed-integer programming instances
- **TSPLIB**: Traveling salesman instances for logistics

## Dataset Structure
```
P10/
├── or_library/       # OR-Library supply chain instances
├── miplib/           # MIPLIB instances
├── custom/           # Generated supply chain scenarios
└── README.md         # This file
```

## Data Format
Each instance contains:
- **Suppliers**: Locations, capacities, lead times, costs
- **Components**: GPU chips, memory, cooling, power supply, PCB
- **Facilities**: Assembly, testing with capacity constraints
- **Dependencies**: Infrastructure and process dependencies
- **Budget**: Total project budget constraints
- **Risks**: Supply shortages, machine breakdowns

## Download Instructions

### Option 1: Download OR-Library Instances
```bash
# OR-Library Supply Chain
wget http://people.brunel.ac.uk/~mastjjb/jeb/orlib/scpinfo.html
# Download individual instance files
```

### Option 2: Download MIPLIB Instances
```bash
# MIPLIB
# Visit: https://miplib.zib.de/
# Download mixed-integer programming instances
```

### Option 3: Generate Custom Instances
```bash
python generate_supply_chain_instances.py --num_instances 100
```

## Usage
See `examples/evaluation_example.py` for how to load and use these datasets.

