#!/usr/bin/env python3
"""
Generate disruption scenarios for P8 (Wedding Logistics with Disruptions).
"""
import json
import random
import argparse
from pathlib import Path

def add_disruptions_to_instance(base_instance, instance_id):
    """Add disruptions to a base wedding logistics instance."""
    disruptions = [
        {
            "type": "road_closure",
            "route": "hotel-church",
            "duration": random.randint(30, 90),
            "start_time": "13:00"
        },
        {
            "type": "traffic_delay",
            "route": "airport-hotel",
            "delay": random.randint(15, 45),
            "start_time": "14:00"
        }
    ]
    
    base_instance["instance_id"] = f"p8_instance_{instance_id:03d}"
    base_instance["disruptions"] = disruptions
    base_instance["description"] = "Wedding logistics with disruptions instance"
    
    return base_instance

def main():
    parser = argparse.ArgumentParser(description="Generate P8 disruption scenarios")
    parser.add_argument("--base_dataset", type=str, default="../P5/custom", help="Base dataset directory")
    parser.add_argument("--output", type=str, default="disruptions", help="Output directory")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    args = parser.parse_args()
    
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    base_dir = Path(args.base_dataset)
    
    print(f"Generating {args.num_instances} disruption scenarios...")
    
    for i in range(1, args.num_instances + 1):
        # Try to load base instance if available
        base_file = base_dir / f"p5_instance_{i:03d}.json"
        if base_file.exists():
            with open(base_file, 'r') as f:
                base_instance = json.load(f)
        else:
            # Create a minimal base instance
            base_instance = {
                "locations": {"B": "Boston Airport", "G": "Gift shop", "T": "Tailor shop", "W": "Wedding venue"},
                "vehicles": [{"id": "van", "capacity": 8, "location": "hotel"}],
                "guests": [{"name": "Guest1", "location": "B", "needs_ride": True}]
            }
        
        instance = add_disruptions_to_instance(base_instance, i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} disruption instances in {output_dir}/")

if __name__ == "__main__":
    main()

