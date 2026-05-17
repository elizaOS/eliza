#!/usr/bin/env python3
"""
Generate custom multi-group campus tour instances for P2.
"""
import json
import random
import argparse
from pathlib import Path

def generate_multi_group_instance(instance_id, num_groups=3, num_guides=3):
    """Generate a single multi-group campus tour instance."""
    # Generate visitor groups
    groups = []
    for i in range(1, num_groups + 1):
        groups.append({
            "group_id": f"group{i}",
            "size": random.randint(5, 15),
            "preferred_time": random.randint(9, 14),  # 9 AM to 2 PM
            "arrival_time": random.randint(8, 12)
        })
    
    # Generate tour guides
    guides = []
    for i in range(1, num_guides + 1):
        start_hour = random.randint(8, 10)
        end_hour = random.randint(15, 18)
        guides.append({
            "guide_id": f"guide{i}",
            "availability": [start_hour, end_hour],
            "max_group_size": 15
        })
    
    instance = {
        "instance_id": f"p2_instance_{instance_id:03d}",
        "visitor_groups": groups,
        "tour_guides": guides,
        "tour_duration": 90,  # 90 minutes per tour
        "max_group_size": 15,
        "description": "Multi-group campus tours with multiple guides"
    }
    
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate P2 multi-group tour instances")
    parser.add_argument("--num_instances", type=int, default=100, help="Number of instances to generate")
    parser.add_argument("--output_dir", type=str, default="custom", help="Output directory")
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating {args.num_instances} multi-group tour instances...")
    
    for i in range(1, args.num_instances + 1):
        instance = generate_multi_group_instance(i)
        output_file = output_dir / f"{instance['instance_id']}.json"
        
        with open(output_file, 'w') as f:
            json.dump(instance, f, indent=2)
    
    print(f"Generated {args.num_instances} instances in {output_dir}/")

if __name__ == "__main__":
    main()

