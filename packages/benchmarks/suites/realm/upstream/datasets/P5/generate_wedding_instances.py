#!/usr/bin/env python3
"""
Generate custom wedding logistics instances for P5.
"""
import json
import random
import argparse
from pathlib import Path

def generate_wedding_instance(instance_id):
    """Generate a single wedding logistics instance."""
    locations = {
        "B": "Boston Airport",
        "G": "Gift shop",
        "T": "Tailor shop",
        "W": "Wedding venue"
    }
    
    travel_times = {
        "B-G": 45,
        "B-T": 30,
        "B-W": 40,
        "G-T": 20,
        "G-W": 25,
        "T-W": 15
    }
    
    guests = [
        {
            "name": "Alex",
            "location": "B",
            "arrival_time": "11:00",
            "origin": "Chicago",
            "needs_ride": True
        },
        {
            "name": "Jamie",
            "location": "B",
            "arrival_time": "12:30",
            "origin": "Atlanta",
            "needs_ride": True
        },
        {
            "name": "Pat",
            "location": "W",
            "arrival_time": "12:00",
            "origin": "NYC",
            "has_car": True,
            "car_capacity": 5
        }
    ]
    
    vehicles = [
        {"id": "van", "capacity": 8, "location": "hotel"},
        {"id": "car1", "capacity": 4, "location": "church"},
        {"id": "car2", "capacity": 4, "location": "reception_venue"}
    ]
    
    errands = ["flowers", "cake", "decorations", "photographer", "music"]
    
    instance = {
        "instance_id": f"p5_instance_{instance_id:03d}",
        "locations": locations,
        "travel_times": travel_times,
        "guests": guests,
        "vehicles": vehicles,
        "errands": errands,
        "constraints": {
            "wedding_deadline": "18:00",
            "gift_store_opens": "12:00",
            "tailor_closes": "14:00",
            "photo_time": "15:00"
        },
        "description": "Wedding logistics coordination instance"
    }
    
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate P5 wedding logistics instances")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    parser.add_argument("--output_dir", type=str, default="custom", help="Output directory")
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating {args.num_instances} wedding logistics instances...")
    
    for i in range(1, args.num_instances + 1):
        instance = generate_wedding_instance(i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} instances in {output_dir}/")

if __name__ == "__main__":
    main()

