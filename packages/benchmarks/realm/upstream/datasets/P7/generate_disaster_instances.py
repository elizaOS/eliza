#!/usr/bin/env python3
"""
Generate custom disaster relief instances for P7.
"""
import json
import random
import argparse
from pathlib import Path

def generate_disaster_instance(instance_id):
    """Generate a single disaster relief instance."""
    regions = [
        {
            "id": "region1",
            "severity": "critical",
            "needs": ["medical", "food"],
            "population": random.randint(1000, 5000),
            "location": {"lat": random.uniform(30, 40), "lon": random.uniform(-100, -80)}
        },
        {
            "id": "region2",
            "severity": "urgent",
            "needs": ["water", "shelter"],
            "population": random.randint(500, 3000),
            "location": {"lat": random.uniform(30, 40), "lon": random.uniform(-100, -80)}
        }
    ]
    
    resources = {
        "medical_supplies": random.randint(800, 1200),
        "food": random.randint(4000, 6000),
        "water": random.randint(1500, 2500),
        "shelter": random.randint(500, 1000)
    }
    
    personnel = {
        "doctors": random.randint(15, 25),
        "nurses": random.randint(40, 60),
        "logistics": random.randint(25, 35)
    }
    
    vehicles = [
        {
            "id": "helicopter1",
            "type": "helicopter",
            "capacity": 1000,
            "speed": "fast",
            "location": "base"
        },
        {
            "id": "truck1",
            "type": "truck",
            "capacity": 5000,
            "speed": "slow",
            "location": "base"
        }
    ]
    
    deadlines = {
        "critical": 2,   # 2 hours
        "urgent": 6,     # 6 hours
        "normal": 24     # 24 hours
    }
    
    disruption_scenarios = [
        {
            "type": "weather_event",
            "region": "region1",
            "impact": "transport_blocked",
            "duration": random.randint(2, 8)
        },
        {
            "type": "resource_shortage",
            "resource": "medical_supplies",
            "shortage": random.uniform(0.2, 0.4)
        }
    ]
    
    instance = {
        "instance_id": f"p7_instance_{instance_id:03d}",
        "regions": regions,
        "resources": resources,
        "personnel": personnel,
        "vehicles": vehicles,
        "deadlines": deadlines,
        "disruption_scenarios": disruption_scenarios,
        "description": "Disaster relief deployment instance"
    }
    
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate P7 disaster relief instances")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    parser.add_argument("--output_dir", type=str, default="processed", help="Output directory")
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating {args.num_instances} disaster relief instances...")
    
    for i in range(1, args.num_instances + 1):
        instance = generate_disaster_instance(i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} instances in {output_dir}/")

if __name__ == "__main__":
    main()

