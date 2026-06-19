#!/usr/bin/env python3
"""
Generate custom Thanksgiving dinner planning instances for P6.
"""
import json
import random
import argparse
from pathlib import Path

def generate_thanksgiving_instance(instance_id):
    """Generate a single Thanksgiving dinner planning instance."""
    vehicles = [
        {"id": "car1", "capacity": 4, "location": "home"},
        {"id": "car2", "capacity": 4, "location": "airport"}
    ]
    
    cooking_tasks = ["turkey", "stuffing", "gravy", "potatoes", "vegetables", "dessert"]
    
    family_members = [
        {
            "id": "mom",
            "skills": ["turkey", "gravy"],
            "arrival": "home",
            "flight": None
        },
        {
            "id": "dad",
            "skills": ["potatoes"],
            "arrival": "airport",
            "flight": "flight1"
        },
        {
            "id": "sister",
            "skills": ["vegetables", "dessert"],
            "arrival": "airport",
            "flight": "flight2"
        }
    ]
    
    flights = {
        "flight1": {"arrival_time": "14:00", "airport": "JFK"},
        "flight2": {"arrival_time": "15:30", "airport": "JFK"}
    }
    
    cooking_dependencies = [
        ["turkey", "gravy"],
        ["potatoes", "mashed_potatoes"]
    ]
    
    instance = {
        "instance_id": f"p6_instance_{instance_id:03d}",
        "vehicles": vehicles,
        "cooking_tasks": cooking_tasks,
        "family_members": family_members,
        "flights": flights,
        "cooking_dependencies": cooking_dependencies,
        "constraints": {
            "dinner_deadline": "18:00",
            "max_cooks": 3,
            "kitchen_capacity": 3
        },
        "description": "Thanksgiving dinner planning instance"
    }
    
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate P6 Thanksgiving instances")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    parser.add_argument("--output_dir", type=str, default="custom", help="Output directory")
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating {args.num_instances} Thanksgiving instances...")
    
    for i in range(1, args.num_instances + 1):
        instance = generate_thanksgiving_instance(i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} instances in {output_dir}/")

if __name__ == "__main__":
    main()

