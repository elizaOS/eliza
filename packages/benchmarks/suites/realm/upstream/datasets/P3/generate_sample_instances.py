#!/usr/bin/env python3
"""
Generate sample URS instances for P3.
"""
import json
import random
import argparse
from pathlib import Path

def generate_urs_instance(instance_id):
    """Generate a single URS instance."""
    locations = ["downtown", "airport", "suburb", "park", "mall", "university", "hospital", "stadium"]
    num_locations = random.randint(5, 8)
    selected_locations = random.sample(locations, num_locations)
    
    # Generate distances between locations
    distances = {}
    for i, loc1 in enumerate(selected_locations):
        for loc2 in selected_locations[i+1:]:
            dist = random.randint(5, 45)
            distances[f"{loc1}-{loc2}"] = dist
            distances[f"{loc2}-{loc1}"] = dist
    
    # Generate ride requests
    num_requests = random.randint(3, 8)
    ride_requests = []
    for i in range(num_requests):
        pickup = random.choice(selected_locations)
        dropoff = random.choice([loc for loc in selected_locations if loc != pickup])
        start_hour = random.randint(8, 16)
        start_min = random.choice([0, 15, 30, 45])
        end_min = start_min + random.randint(15, 45)
        if end_min >= 60:
            end_min -= 60
            start_hour += 1
        
        ride_requests.append({
            "passenger_id": f"p{i+1:03d}",
            "pickup": pickup,
            "dropoff": dropoff,
            "time_window": [start_hour + start_min/60, start_hour + end_min/60],
            "deadline": random.randint(20, 60)
        })
    
    # Generate vehicles
    num_vehicles = random.randint(2, 5)
    vehicles = []
    for i in range(num_vehicles):
        vehicles.append({
            "vehicle_id": f"v{i+1:03d}",
            "location": random.choice(selected_locations),
            "capacity": random.choice([3, 4, 5, 6]),
            "fuel": random.randint(50, 100)
        })
    
    instance = {
        "instance_id": f"p3_instance_{instance_id:03d}",
        "city_map": {
            "locations": selected_locations,
            "distances": distances
        },
        "ride_requests": ride_requests,
        "vehicles": vehicles,
        "description": "Urban ride-sharing instance"
    }
    
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate P3 URS instances")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    parser.add_argument("--output_dir", type=str, default="processed", help="Output directory")
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating {args.num_instances} URS instances...")
    
    for i in range(1, args.num_instances + 1):
        instance = generate_urs_instance(i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} instances in {output_dir}/")

if __name__ == "__main__":
    main()

