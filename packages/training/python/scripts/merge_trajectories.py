#!/usr/bin/env python3
"""
Merge Trajectories from Multiple Workers

Combines trajectory files from parallel generation workers into a single
output directory, handling deduplication and validation.

Usage:
    python scripts/merge_trajectories.py ./training-data-output
    python scripts/merge_trajectories.py ./training-data-output --output ./merged
    python scripts/merge_trajectories.py ./training-data-output --validate

Requirements:
    - Trajectory JSON files from generate_dataset.sh
"""

import argparse
import hashlib
import json
import logging
import os
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Set

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


@dataclass
class MergeStats:
    """Statistics for merge operation"""
    total_files_found: int = 0
    valid_trajectories: int = 0
    duplicate_trajectories: int = 0
    invalid_trajectories: int = 0
    merged_trajectories: int = 0
    archetypes: Dict[str, int] = None
    
    def __post_init__(self):
        if self.archetypes is None:
            self.archetypes = {}
    
    def record_archetype(self, archetype: str):
        self.archetypes[archetype] = self.archetypes.get(archetype, 0) + 1


def generate_content_hash(data: Dict) -> str:
    """Generate a hash of trajectory content for deduplication"""
    # Use trajectory ID if available
    if "trajectoryId" in data:
        return data["trajectoryId"]
    
    # Otherwise hash the content
    content = json.dumps(data, sort_keys=True)
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def validate_trajectory(data: Dict) -> tuple[bool, List[str]]:
    """
    Validate trajectory data structure.
    
    Returns:
        (is_valid, list_of_issues)
    """
    issues = []
    
    # Handle wrapped format
    if "trajectory" in data:
        data = data["trajectory"]
    
    # Check required fields
    required = ["trajectoryId", "agentId"]
    for field in required:
        if not data.get(field):
            issues.append(f"Missing field: {field}")
    
    # Check steps
    steps = data.get("stepsJson", "[]")
    if isinstance(steps, str):
        try:
            steps = json.loads(steps)
        except json.JSONDecodeError:
            issues.append("Invalid stepsJson")
            steps = []
    
    if len(steps) == 0:
        issues.append("No steps in trajectory")
    
    return len(issues) == 0, issues


def extract_archetype(data: Dict) -> str:
    """Extract archetype from trajectory data"""
    if "trajectory" in data:
        data = data["trajectory"]
    
    archetype = data.get("archetype")
    if archetype and archetype != "default":
        return archetype
    
    # Try to extract from steps
    steps = data.get("stepsJson", "[]")
    if isinstance(steps, str):
        try:
            steps = json.loads(steps)
        except json.JSONDecodeError:
            return "default"
    
    for step in steps:
        action = step.get("action", {})
        params = action.get("parameters", {})
        if params.get("archetype"):
            return params["archetype"]
    
    return "default"


def find_trajectory_files(source_dir: Path) -> List[Path]:
    """Find all trajectory JSON files in source directory"""
    files = []
    
    # Check for batch_N directories
    batch_dirs = list(source_dir.glob("batch_*/trajectories"))
    
    if batch_dirs:
        for batch_dir in batch_dirs:
            files.extend(batch_dir.glob("*.json"))
    else:
        # Check for direct trajectories directory
        traj_dir = source_dir / "trajectories"
        if traj_dir.exists():
            files.extend(traj_dir.glob("*.json"))
        else:
            # Check source dir itself
            files.extend(source_dir.glob("*.json"))
    
    return sorted(files)


def merge_trajectories(
    source_dir: Path,
    output_dir: Path,
    validate: bool = True,
    dry_run: bool = False,
) -> MergeStats:
    """
    Merge trajectories from multiple workers.
    
    Args:
        source_dir: Directory containing batch_N subdirectories
        output_dir: Output directory for merged trajectories
        validate: Whether to validate trajectories before merging
        dry_run: If True, don't actually copy files
    
    Returns:
        Merge statistics
    """
    stats = MergeStats()
    seen_hashes: Set[str] = set()
    
    # Find all trajectory files
    files = find_trajectory_files(source_dir)
    stats.total_files_found = len(files)
    
    if stats.total_files_found == 0:
        logger.warning(f"No trajectory files found in {source_dir}")
        return stats
    
    logger.info(f"Found {stats.total_files_found} trajectory files")
    
    # Create output directory
    output_traj_dir = output_dir / "trajectories"
    if not dry_run:
        output_traj_dir.mkdir(parents=True, exist_ok=True)
    
    # Process each file
    for file_path in files:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            logger.warning(f"Invalid JSON in {file_path}: {e}")
            stats.invalid_trajectories += 1
            continue
        
        # Validate if requested
        if validate:
            is_valid, issues = validate_trajectory(data)
            if not is_valid:
                logger.debug(f"Invalid trajectory {file_path}: {issues}")
                stats.invalid_trajectories += 1
                continue
        
        stats.valid_trajectories += 1
        
        # Check for duplicates
        content_hash = generate_content_hash(data)
        if content_hash in seen_hashes:
            stats.duplicate_trajectories += 1
            continue
        seen_hashes.add(content_hash)
        
        # Record archetype
        archetype = extract_archetype(data)
        stats.record_archetype(archetype)
        
        # Copy to output
        if not dry_run:
            output_file = output_traj_dir / file_path.name
            
            # Handle name collisions
            if output_file.exists():
                base = file_path.stem
                suffix = file_path.suffix
                counter = 1
                while output_file.exists():
                    output_file = output_traj_dir / f"{base}_{counter}{suffix}"
                    counter += 1
            
            shutil.copy2(file_path, output_file)
        
        stats.merged_trajectories += 1
    
    return stats


def main():
    parser = argparse.ArgumentParser(
        description="Merge trajectories from multiple generation workers"
    )
    parser.add_argument(
        "source_dir",
        type=Path,
        help="Source directory containing batch_N subdirectories"
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=None,
        help="Output directory (default: source_dir/merged)"
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate trajectories before merging"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without copying files"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output"
    )
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    if not args.source_dir.exists():
        logger.error(f"Source directory not found: {args.source_dir}")
        sys.exit(1)
    
    output_dir = args.output or (args.source_dir / "merged")
    
    if args.dry_run:
        logger.info("DRY RUN MODE - No files will be copied")
    
    logger.info(f"Merging trajectories from {args.source_dir}")
    logger.info(f"Output directory: {output_dir}")
    
    stats = merge_trajectories(
        source_dir=args.source_dir,
        output_dir=output_dir,
        validate=args.validate,
        dry_run=args.dry_run,
    )
    
    # Print summary
    print("\n" + "=" * 50)
    print("MERGE SUMMARY")
    print("=" * 50)
    print(f"Total files found:      {stats.total_files_found}")
    print(f"Valid trajectories:     {stats.valid_trajectories}")
    print(f"Invalid trajectories:   {stats.invalid_trajectories}")
    print(f"Duplicate trajectories: {stats.duplicate_trajectories}")
    print(f"Merged trajectories:    {stats.merged_trajectories}")
    
    if stats.archetypes:
        print("\nArchetype distribution:")
        for archetype, count in sorted(stats.archetypes.items()):
            pct = (count / stats.merged_trajectories * 100) if stats.merged_trajectories > 0 else 0
            print(f"  {archetype}: {count} ({pct:.1f}%)")
    
    if not args.dry_run:
        print(f"\nMerged trajectories saved to: {output_dir / 'trajectories'}")
    
    if stats.invalid_trajectories > stats.total_files_found * 0.1:
        logger.warning("More than 10% of trajectories are invalid")
        sys.exit(1)
    
    sys.exit(0)


if __name__ == "__main__":
    main()


