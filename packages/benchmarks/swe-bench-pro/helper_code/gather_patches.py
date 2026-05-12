#!/usr/bin/env python3
"""
Script to gather .pred patch files from a directory structure and format them for swe_bench_pro_eval.py.

The .pred files contain model-generated patches, either as plain text or JSON with a model_patch field.

Usage:
    python gather_patches.py --directory <path> --prefix <prefix> --output <output_file>

Examples:
    # From trajectory results directory
    python gather_patches.py --directory swe_bench_pro_results/sample1 --prefix sample1 --output sample1_patches.json

    # From any directory with instance folders containing .pred files
    python gather_patches.py --directory trajectory_results/sample_1 --prefix grok-code-fast-1 --output grok-code-fast-1_patches.json
"""

import argparse
import json
from pathlib import Path
from typing import List, Dict, Optional


def find_pred_file(directory: Path, instance_id: str) -> Optional[Path]:
    """
    Find the .pred file in a directory.
    
    Args:
        directory: The directory to search
        instance_id: The instance_id to look for
        
    Returns:
        Path to the .pred file or None if not found
    """
    # Look for files matching the pattern: <instance_id>*.pred
    pred_files = list(directory.glob(f"{instance_id}*.pred"))
    if pred_files:
        return pred_files[0]
    
    pred_files = list(directory.glob("*.pred"))
    if pred_files:
        return pred_files[0]
    
    return None


def gather_patches_from_local(directory: str, prefix: str) -> List[Dict[str, str]]:
    """
    Gather patches from a local directory.
    
    Args:
        directory: Path to the directory containing instance folders
        prefix: Prefix to add to each patch entry
        
    Returns:
        List of patch dictionaries
    """
    patches = []
    directory_path = Path(directory)
    
    if not directory_path.exists():
        raise FileNotFoundError(f"Directory not found: {directory}")
    
    for item in sorted(directory_path.iterdir()):
        if not item.is_dir():
            continue
        
        if not item.name.startswith('instance_'):
            continue
        
        pred_file = find_pred_file(item, item.name)
        if not pred_file:
            print(f"Warning: No .pred file found in {item.name}")
            continue
        
        try:
            with open(pred_file, 'r') as f:
                content = f.read()
            
            instance_id = None
            patch_content = content
            
            try:
                pred_data = json.loads(content)
                
                if 'instance_id' in pred_data:
                    instance_id = pred_data['instance_id']
                
                if 'model_patch' in pred_data:
                    patch_content = pred_data['model_patch']
                elif 'patch' in pred_data:
                    patch_content = pred_data['patch']
                    
            except json.JSONDecodeError:
                pass
            
            if not instance_id:
                instance_id = item.name
                print(f"Warning: Using folder name as instance_id for {item.name}")
            
            patches.append({
                "instance_id": instance_id,
                "patch": patch_content,
                "prefix": prefix
            })
        except Exception as e:
            print(f"Error reading {pred_file}: {e}")
    
    return patches


def main():
    parser = argparse.ArgumentParser(
        description='Gather .pred file patches and format them for swe_bench_pro_eval.py',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument(
        '--directory',
        type=str,
        required=True,
        help='Local directory containing instance folders'
    )
    parser.add_argument(
        '--prefix',
        type=str,
        required=True,
        help='Prefix to add to each patch entry'
    )
    parser.add_argument(
        '--output',
        type=str,
        required=True,
        help='Output JSON file path'
    )
    
    args = parser.parse_args()
    
    patches = gather_patches_from_local(args.directory, args.prefix)
    
    print(f"Found {len(patches)} patches, writing to {args.output}")
    
    with open(args.output, 'w') as f:
        json.dump(patches, f, indent=2)


if __name__ == '__main__':
    main()
