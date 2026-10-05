#!/usr/bin/env python3
"""
Generate custom campus tour instances for P1.
"""
import json
import random
import argparse
from pathlib import Path

def generate_campus_instance(instance_id, num_locations=5):
    """Generate a single campus tour instance."""
    locations = ["entrance", "library", "cafeteria", "gym", "student_center"]
    locations = locations[:num_locations]
    
    # Generate distances between locations (in minutes)
    distances = {}
    for i, loc1 in enumerate(locations):
        for j, loc2 in enumerate(locations):
            if i != j:
                # Random distance between 5-30 minutes
                dist = random.randint(5, 30)
                distances[f"{loc1}-{loc2}"] = dist
    
    # Generate time windows
    time_windows = {
        "library": [9, 12],      # 9:00 AM - 12:00 PM
        "cafeteria": [11, 14],   # 11:00 AM - 2:00 PM
        "gym": [15, 18],         # 3:00 PM - 6:00 PM
        "student_center": [10, 16]  # 10:00 AM - 4:00 PM
    }
    
    instance = {
        "instance_id": f"p1_instance_{instance_id:03d}",
        "locations": locations,
        "start_location": "entrance",
        "end_location": "entrance",
        "distances": distances,
        "time_windows": time_windows,
        "max_duration": 180,  # 3 hours
        "description": "Single-agent campus tour with time windows"
    }
    
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate P1 campus tour instances")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    parser.add_argument("--output_dir", type=str, default="custom", help="Output directory")
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating {args.num_instances} campus tour instances...")
    
    for i in range(1, args.num_instances + 1):
        instance = generate_campus_instance(i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} instances in {output_dir}/")
    
    # Create a summary file
    summary = {
        "total_instances": args.num_instances,
        "output_directory": str(output_dir),
        "format": "JSON"
    }
    
    with open(output_dir / "summary.json", 'w') as f:
        json.dump(summary, f, indent=2)

if __name__ == "__main__":
    main()

