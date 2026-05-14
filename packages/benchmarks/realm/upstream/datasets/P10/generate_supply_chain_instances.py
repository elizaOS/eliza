#!/usr/bin/env python3
"""
Generate custom GPU supply chain instances for P10.
"""
import json
import random
import argparse
from pathlib import Path

def generate_supply_chain_instance(instance_id):
    """Generate a single supply chain instance."""
    suppliers = [
        {
            "supplier_id": "supplier1",
            "location": "asia",
            "capacity": random.randint(800, 1200),
            "lead_time": random.randint(25, 35),
            "cost_multiplier": 1.0
        },
        {
            "supplier_id": "supplier2",
            "location": "europe",
            "capacity": random.randint(600, 1000),
            "lead_time": random.randint(40, 50),
            "cost_multiplier": 1.2
        }
    ]
    
    components = ["gpu_chips", "memory", "cooling", "power_supply", "pcb"]
    
    facilities = [
        {
            "facility_id": "assembly",
            "location": "usa",
            "capacity": random.randint(400, 600),
            "cost_per_unit": 100
        },
        {
            "facility_id": "testing",
            "location": "usa",
            "capacity": random.randint(250, 350),
            "cost_per_unit": 50
        }
    ]
    
    instance = {
        "instance_id": f"p10_instance_{instance_id:03d}",
        "suppliers": suppliers,
        "components": components,
        "facilities": facilities,
        "budget": 1000000,
        "delivery_deadlines": {
            "gpu_chips": 30,
            "memory": 45,
            "cooling": 60
        },
        "dependencies": [
            ["power_supply", "assembly"],
            ["testing", "packaging"]
        ],
        "disruption_scenarios": [
            {
                "type": "resource_shortage",
                "component": "gpu_chips",
                "shortage": 0.4
            },
            {
                "type": "machine_breakdown",
                "facility": "assembly",
                "duration": 7
            }
        ],
        "description": "Global GPU supply chain planning instance"
    }
    
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate P10 supply chain instances")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    parser.add_argument("--output_dir", type=str, default="custom", help="Output directory")
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating {args.num_instances} supply chain instances...")
    
    for i in range(1, args.num_instances + 1):
        instance = generate_supply_chain_instance(i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} instances in {output_dir}/")

if __name__ == "__main__":
    main()

