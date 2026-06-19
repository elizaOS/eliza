#!/usr/bin/env python3
"""
Generate disruption scenarios for P9 (Thanksgiving Dinner with Disruptions).
"""
import json
import random
import argparse
from pathlib import Path

def add_disruptions_to_instance(base_instance, instance_id):
    """Add disruptions to a base Thanksgiving instance."""
    disruptions = [
        {
            "type": "flight_delay",
            "flight": "flight1",
            "delay": random.randint(60, 120),  # 1-2 hours
            "new_arrival_time": None  # Will be calculated
        },
        {
            "type": "flight_delay",
            "flight": "flight2",
            "delay": random.randint(30, 90),  # 30-90 minutes
            "new_arrival_time": None
        }
    ]
    
    # Update flight arrival times
    if "flights" in base_instance:
        for disruption in disruptions:
            flight_id = disruption["flight"]
            if flight_id in base_instance["flights"]:
                original_time = base_instance["flights"][flight_id]["arrival_time"]
                # Simple time addition (in minutes)
                disruption["new_arrival_time"] = f"{int(original_time.split(':')[0]) + (disruption['delay'] // 60)}:{(disruption['delay'] % 60):02d}"
    
    base_instance["instance_id"] = f"p9_instance_{instance_id:03d}"
    base_instance["disruptions"] = disruptions
    base_instance["description"] = "Thanksgiving dinner with disruptions instance"
    
    return base_instance

def main():
    parser = argparse.ArgumentParser(description="Generate P9 disruption scenarios")
    parser.add_argument("--base_dataset", type=str, default="../P6/custom", help="Base dataset directory")
    parser.add_argument("--output", type=str, default="disruptions", help="Output directory")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    args = parser.parse_args()
    
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    base_dir = Path(args.base_dataset)
    
    print(f"Generating {args.num_instances} disruption scenarios...")
    
    for i in range(1, args.num_instances + 1):
        # Try to load base instance if available
        base_file = base_dir / f"p6_instance_{i:03d}.json"
        if base_file.exists():
            with open(base_file, 'r') as f:
                base_instance = json.load(f)
        else:
            # Create a minimal base instance
            base_instance = {
                "flights": {
                    "flight1": {"arrival_time": "14:00", "airport": "JFK"},
                    "flight2": {"arrival_time": "15:30", "airport": "JFK"}
                },
                "cooking_tasks": ["turkey", "stuffing", "gravy"],
                "family_members": [{"id": "mom", "flight": "flight1"}]
            }
        
        instance = add_disruptions_to_instance(base_instance, i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} disruption instances in {output_dir}/")

if __name__ == "__main__":
    main()

