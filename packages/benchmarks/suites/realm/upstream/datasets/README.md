# REALM-Bench Datasets

This directory contains datasets for all benchmark problems (P1-P11, J1-J4).

## Directory Structure

```
datasets/
├── P1/          # Single-Agent Campus Tour
├── P2/          # Multi-Group Campus Tours
├── P3/          # Urban Ride-Sharing (URS)
├── P4/          # URS with Disruptions
├── P5/          # Wedding Logistics
├── P6/          # Thanksgiving Dinner Planning
├── P7/          # Disaster Relief Deployment
├── P8/          # Wedding Logistics with Disruptions
├── P9/          # Thanksgiving Dinner with Disruptions
├── P10/         # Global GPU Supply Chain
├── J1/          # JSSP Basic (Static) - Already populated
├── J2/          # JSSP Basic with Disruptions
├── J3/          # JSSP Large-scale, Sequential Planning
├── J4/          # JSSP Large-scale with Disruptions
└── README.md    # This file
```

## Quick Start

### Generate Sample Datasets

For problems that support synthetic generation:

```bash
# P1: Campus Tours
cd P1 && python generate_campus_instances.py --num_instances 100

# P2: Multi-Group Tours
cd P2 && python generate_multi_group_instances.py --num_instances 100

# P10: Supply Chain
cd P10 && python generate_supply_chain_instances.py --num_instances 100

# J2: JSSP with Disruptions (from J1)
cd J2 && python generate_disruptions.py --base_dataset ../J1 --output disruptions/

# J3: Large-scale JSSP
cd J3 && python scale_j1_instances.py --base_dataset ../J1 --scale_factor 10 --output scaled/
cd J3 && python scale_j1_instances.py --num_jobs 200 --num_machines 50 --num_instances 100

# J4: Large-scale JSSP with Disruptions
cd J4 && python generate_large_scale_disruptions.py --base_dataset ../J3/scaled --output disrupted_large/
cd J4 && python generate_large_scale_disruptions.py --num_jobs 200 --num_machines 50 --num_disruptions 3 --num_instances 100
```

### Download Public Datasets

For problems with public data sources, see individual README files in each problem directory for download instructions.

## Dataset Formats

- **JSON**: Most custom-generated instances use JSON format
- **CSV**: Public datasets (taxi data, traffic data) use CSV
- **TXT**: Standard optimization instances (TSPLIB, OR-Library) use text format

## Usage in Evaluation

See `examples/evaluation_example.py` for how to load and use these datasets in the evaluation framework.

## Notes

- **P11/J1**: Already populated with JSSP benchmark instances (DMU, TA, ABZ, SWV, YN)
- **J2**: Extends J1 with disruptions - use `generate_disruptions.py` to add disruptions to J1 instances
- **J3**: Large-scale version of J1 - can scale existing J1 instances or generate custom large-scale instances
- **J4**: Most challenging - combines J3's scale with J2's disruptions - requires J3 instances as base
- **P3, P4**: Require downloading large public datasets (NYC/Chicago taxi data)
- **P7**: Requires UN OCHA or FEMA data access
- **P5, P6, P8, P9**: Primarily use synthetic generation with some public data sources

