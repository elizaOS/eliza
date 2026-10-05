#!/usr/bin/env python3
"""
Generate disruption scenarios for P4 (URS with Disruptions).
"""
import json
import random
import argparse
from pathlib import Path

def add_disruptions_to_urs(base_instance, instance_id):
    """Add disruptions to a base URS instance."""
    disruptions = []
    
    # Generate 1-3 disruptions
    num_disruptions = random.randint(1, 3)
    
    for i in range(num_disruptions):
        disruption_type = random.choice(["traffic_delay", "road_closure", "accident", "construction"])
        
        if disruption_type == "traffic_delay":
            # Get a route from the instance
            routes = list(base_instance.get("city_map", {}).get("distances", {}).keys())
            if routes:
                route = random.choice(routes)
                disruption = {
                    "type": "traffic_delay",
                    "route": route,
                    "delay": random.randint(10, 45),
                    "start_time": random.randint(8, 16),
                    "duration": random.randint(30, 120),
                    "impact": "increased_travel_time"
                }
                disruptions.append(disruption)
        elif disruption_type == "road_closure":
            routes = list(base_instance.get("city_map", {}).get("distances", {}).keys())
            if routes:
                route = random.choice(routes)
                disruption = {
                    "type": "road_closure",
                    "route": route,
                    "start_time": random.randint(9, 15),
                    "duration": random.randint(60, 180),
                    "impact": "route_unavailable"
                }
                disruptions.append(disruption)
        elif disruption_type == "accident":
            locations = base_instance.get("city_map", {}).get("locations", [])
            if locations:
                location = random.choice(locations)
                disruption = {
                    "type": "accident",
                    "location": location,
                    "start_time": random.randint(8, 14),
                    "duration": random.randint(20, 90),
                    "impact": "local_traffic_congestion"
                }
                disruptions.append(disruption)
        else:  # construction
            routes = list(base_instance.get("city_map", {}).get("distances", {}).keys())
            if routes:
                route = random.choice(routes)
                disruption = {
                    "type": "construction",
                    "route": route,
                    "start_time": random.randint(7, 12),
                    "duration": random.randint(120, 300),
                    "impact": "reduced_capacity"
                }
                disruptions.append(disruption)
    
    base_instance["instance_id"] = f"p4_instance_{instance_id:03d}"
    base_instance["disruptions"] = disruptions
    base_instance["description"] = "Urban ride-sharing with disruptions instance"
    
    return base_instance

def main():
    parser = argparse.ArgumentParser(description="Generate P4 disruption scenarios")
    parser.add_argument("--base_dataset", type=str, default="../P3/processed", help="Base P3 dataset directory")
    parser.add_argument("--output", type=str, default="disruptions", help="Output directory")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    args = parser.parse_args()
    
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    base_dir = Path(args.base_dataset)
    
    print(f"Generating {args.num_instances} disruption scenarios...")
    
    # Try to load base instances if available
    p3_files = list(base_dir.glob("*.json")) if base_dir.exists() else []
    
    for i in range(1, args.num_instances + 1):
        # Try to load base instance if available
        if i <= len(p3_files) and p3_files[i-1].exists():
            with open(p3_files[i-1], 'r') as f:
                base_instance = json.load(f)
        else:
            # Create a minimal base instance
            base_instance = {
                "city_map": {
                    "locations": ["downtown", "airport", "suburb"],
                    "distances": {
                        "downtown-airport": 30,
                        "downtown-suburb": 20,
                        "airport-suburb": 25
                    }
                },
                "ride_requests": [{"passenger_id": "p001", "pickup": "downtown", "dropoff": "airport"}],
                "vehicles": [{"vehicle_id": "v001", "location": "downtown", "capacity": 4}]
            }
        
        instance = add_disruptions_to_urs(base_instance, i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} disruption instances in {output_dir}/")

if __name__ == "__main__":
    main()

