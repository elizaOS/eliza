"""
Market Research Excel Task Preprocessing Script

This script generates the Excel files with market data for the task.
It supports different difficulty levels and configurable parameters.
"""

import sys
import os
import shutil
from pathlib import Path
from argparse import ArgumentParser
from typing import Dict, List
from gem.utils.filesystem import nfs_safe_rmtree

def clean_workspace_folders(task_root: Path) -> bool:
    """Clean up initial_workspace and groundtruth_workspace folders"""
    print("=" * 60)
    print("Cleaning Workspace Folders")
    print("=" * 60)
    
    folders_to_clean = [
        task_root / "initial_workspace",
        task_root / "groundtruth_workspace"
    ]
    
    try:
        for folder in folders_to_clean:
            if folder.exists():
                print(f"🗑️  Cleaning: {folder.name}")
                
                # Remove Excel and CSV files
                for pattern in ["*.xlsx", "*.csv", "*.json", "*.md"]:
                    for file in folder.glob(pattern):
                        try:
                            file.unlink()
                            print(f"   ✓ Removed: {file.name}")
                        except Exception as e:
                            print(f"   ⚠️  Could not remove {file.name}: {e}")
            else:
                print(f"📁 Creating: {folder.name}")
                folder.mkdir(parents=True, exist_ok=True)
        
        print("✅ Workspace folders cleaned")
        return True
        
    except Exception as e:
        print(f"❌ Error cleaning folders: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_market_data(task_root: Path,
                        seed: int = 42,
                        start_year: int = 2014,
                        num_years: int = 11,
                        num_raw_categories: int = 10,
                        num_internal_categories: int = 4,
                        difficulty: str = "medium",
                        save_groundtruth: bool = True) -> bool:
    """
    Generate market research data using the data generator
    
    Args:
        task_root: Task root directory
        seed: Random seed for reproducibility
        start_year: Starting year for data
        num_years: Number of years of data
        num_raw_categories: Number of raw market categories
        num_internal_categories: Number of internal company categories
        difficulty: Difficulty level (easy/medium/hard/expert)
        save_groundtruth: Whether to save groundtruth files
        
    Returns:
        True if generation succeeded
    """
    print("=" * 60)
    print("Generating Market Research Data")
    print("=" * 60)
    
    try:
        # Find the generator script
        generator_script = Path(__file__).parent / "generate_market_data.py"
        
        if not generator_script.exists():
            print(f"❌ Generator script not found: {generator_script}")
            return False
        
        # Build command
        import subprocess
        cmd = [
            sys.executable,
            str(generator_script),
            "--output-dir", str(task_root),
            "--seed", str(seed),
            "--start-year", str(start_year),
            "--num-years", str(num_years),
            "--num-raw-categories", str(num_raw_categories),
            "--num-internal-categories", str(num_internal_categories),
            "--difficulty", difficulty
        ]
        
        if save_groundtruth:
            cmd.append("--save-groundtruth")
        
        print(f"🎲 Generation parameters:")
        print(f"   Difficulty: {difficulty}")
        print(f"   Years: {start_year} - {start_year + num_years - 1} ({num_years} years)")
        print(f"   Raw categories: {num_raw_categories}")
        print(f"   Internal categories: {num_internal_categories}")
        print(f"   Seed: {seed}")
        
        # Run the generator
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent)
        )
        
        # Output generator's output
        if result.stdout:
            print(result.stdout)
        
        if result.returncode != 0:
            print(f"❌ Data generation failed:")
            if result.stderr:
                print(result.stderr)
            return False
        
        print("✅ Data generation successful!")
        return True
        
    except Exception as e:
        print(f"❌ Data generation error: {e}")
        import traceback
        traceback.print_exc()
        return False


def copy_initial_workspace_to_agent(task_root: Path, agent_workspace: str) -> bool:
    """Copy initial_workspace contents to agent_workspace"""
    print("=" * 60)
    print("Copying Files to Agent Workspace")
    print("=" * 60)
    
    initial_workspace = task_root / "initial_workspace"
    agent_workspace_path = Path(agent_workspace)
    
    print(f"   Source: {initial_workspace}")
    print(f"   Destination: {agent_workspace_path}")
    
    try:
        if not initial_workspace.exists():
            print(f"❌ initial_workspace does not exist: {initial_workspace}")
            return False
        
        # Ensure agent_workspace exists
        agent_workspace_path.mkdir(parents=True, exist_ok=True)
        
        # Copy all files
        copied_count = 0
        for item in initial_workspace.iterdir():
            dest = agent_workspace_path / item.name
            
            if item.is_file():
                shutil.copy2(item, dest)
                print(f"   ✓ Copied: {item.name}")
                copied_count += 1
            elif item.is_dir():
                if dest.exists():
                    nfs_safe_rmtree(dest)
                shutil.copytree(item, dest)
                print(f"   ✓ Copied directory: {item.name}")
                copied_count += 1
        
        print(f"✅ Successfully copied {copied_count} items to agent_workspace")
        return True
        
    except Exception as e:
        print(f"❌ Copy failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def verify_generated_files(task_root: Path) -> bool:
    """Verify that all required files were generated"""
    print("=" * 60)
    print("Verifying Generated Files")
    print("=" * 60)
    
    required_files = [
        task_root / "initial_workspace" / "Market_Data.xlsx",
        task_root / "initial_workspace" / "Market_Data_Format.xlsx",
        task_root / "groundtruth_workspace" / "Market_Data_gt.csv",
        task_root / "groundtruth_workspace" / "README.md",
        task_root / "groundtruth_workspace" / "metadata.json"
    ]
    
    all_exist = True
    for file_path in required_files:
        if file_path.exists():
            size = file_path.stat().st_size
            print(f"   ✅ {file_path.relative_to(task_root)} ({size} bytes)")
        else:
            print(f"   ❌ Missing: {file_path.relative_to(task_root)}")
            all_exist = False
    
    if all_exist:
        print("✅ All required files generated successfully")
    else:
        print("❌ Some files are missing")
    
    return all_exist


def display_summary(task_root: Path, args) -> None:
    """Display summary of preprocessing"""
    print("\n" + "=" * 60)
    print("🎉 Market Research Task Preprocessing Complete!")
    print("=" * 60)
    
    print(f"✅ Workspace folders cleaned")
    print(f"✅ Market data generated")
    print(f"✅ Groundtruth files saved")
    
    if args.agent_workspace:
        print(f"✅ Files copied to agent workspace")
    
    # Display configuration
    print(f"\n📊 Configuration:")
    print(f"   Difficulty: {args.difficulty}")
    print(f"   Years: {args.start_year} - {args.start_year + args.num_years - 1}")
    print(f"   Raw categories: {args.num_raw_categories}")
    print(f"   Internal categories: {args.num_internal_categories}")
    print(f"   Seed: {args.seed}")
    
    # Display file locations
    print(f"\n📂 Directory Locations:")
    print(f"   Task root: {task_root}")
    print(f"   Initial workspace: {task_root / 'initial_workspace'}")
    print(f"   Groundtruth workspace: {task_root / 'groundtruth_workspace'}")
    
    if args.agent_workspace:
        print(f"   Agent workspace: {args.agent_workspace}")
    
    # Display file info
    print(f"\n📄 Generated Files:")
    print(f"   • Market_Data.xlsx - Main data file with Methodology and RawData sheets")
    print(f"   • Market_Data_Format.xlsx - Example output format")
    print(f"   • Market_Data_gt.csv - Groundtruth growth rates")
    print(f"   • README.md - Calculation steps")
    print(f"   • metadata.json - Task metadata")
    
    print(f"\n💡 Next Steps:")
    print(f"   Agent needs to:")
    print(f"   1. Read Market_Data.xlsx to understand data structure")
    print(f"   2. Extract conversion methodology from Methodology sheet")
    print(f"   3. Process RawData sheet (pay attention to units!)")
    print(f"   4. Calculate growth rates for target category")
    print(f"   5. Save results to growth_rate.xlsx matching the format")


if __name__ == "__main__":
    parser = ArgumentParser(description="Preprocess market research Excel task")
    
    # Standard arguments
    parser.add_argument("--agent_workspace", required=False,
                       help="Agent workspace directory")
    parser.add_argument("--launch_time", required=False,
                       help="Launch time (not used)")
    parser.add_argument("--task_root", required=False,
                       help="Task root directory where files should be generated")
    
    # Data generation parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip data generation, use existing files")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")
    parser.add_argument("--start-year", type=int, default=1989,
                       help="Starting year (default: 2014)")
    parser.add_argument("--num-years", type=int, default=20,
                       help="Number of years (default: 11)")
    parser.add_argument("--num-raw-categories", type=int, default=30,
                       help="Number of raw market categories (default: 5, can go up to 100+)")
    parser.add_argument("--num-internal-categories", type=int, default=5,
                       help="Number of internal categories (default: 3, can go up to 50+)")
    
    # Difficulty presets (optional, for backward compatibility)
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert"],
                       help="Difficulty preset (optional, overrides custom params if specified)")
    
    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("🚀 Market Research Task Preprocessing")
    print("=" * 60)

    # Get task root directory
    if args.task_root:
        task_root = Path(args.task_root)
        print(f"📂 Task root (from args): {task_root}")
    else:
        # Fallback to original logic for backward compatibility
        task_root = Path(__file__).parent.parent
        print(f"📂 Task root: {task_root}")
    
    # Apply difficulty presets ONLY if explicitly specified
    if args.difficulty:
        print(f"🎲 Using difficulty preset: {args.difficulty}")
        if args.difficulty == "easy":
            args.num_raw_categories = 3
            args.num_internal_categories = 2
            args.num_years = 6
            args.start_year = 2019
        elif args.difficulty == "medium":
            args.num_raw_categories = 5
            args.num_internal_categories = 3
            args.num_years = 11
            args.start_year = 2014
        elif args.difficulty == "hard":
            args.num_raw_categories = 10
            args.num_internal_categories = 5
            args.num_years = 11
            args.start_year = 2014
        elif args.difficulty == "expert":
            args.num_raw_categories = 15
            args.num_internal_categories = 7
            args.num_years = 15
            args.start_year = 2010
    else:
        print(f"🎲 Using custom parameters")
        # Set difficulty for metadata purposes
        args.difficulty = "custom"
    
    # Step 0: Clean workspace folders
    print("\n" + "=" * 60)
    print("STEP 0: Clean Workspace Folders")
    print("=" * 60)
    
    if not clean_workspace_folders(task_root):
        print("⚠️  Cleaning failed, but continuing...")
    
    # Step 1: Generate market data
    if not args.skip_generation:
        print("\n" + "=" * 60)
        print("STEP 1: Generate Market Data")
        print("=" * 60)
        
        if not generate_market_data(
            task_root=task_root,
            seed=args.seed,
            start_year=args.start_year,
            num_years=args.num_years,
            num_raw_categories=args.num_raw_categories,
            num_internal_categories=args.num_internal_categories,
            difficulty=args.difficulty,
            save_groundtruth=True
        ):
            print("❌ Data generation failed!")
            sys.exit(1)
    else:
        print("\n" + "=" * 60)
        print("STEP 1: Skip Data Generation")
        print("=" * 60)
        print("Using existing files in initial_workspace/")
    
    # Step 2: Verify generated files
    print("\n" + "=" * 60)
    print("STEP 2: Verify Generated Files")
    print("=" * 60)
    
    if not verify_generated_files(task_root):
        print("❌ File verification failed!")
        if not args.skip_generation:
            sys.exit(1)
        else:
            print("⚠️  Continuing with existing files...")
    
    # Step 3: Copy to agent workspace
    if args.agent_workspace:
        print("\n" + "=" * 60)
        print("STEP 3: Copy to Agent Workspace")
        print("=" * 60)
        
        if not copy_initial_workspace_to_agent(task_root, args.agent_workspace):
            print("⚠️  Copy failed, but continuing...")
    else:
        print("\n⚠️  No agent_workspace specified, skipping copy step")
    
    # Display summary
    display_summary(task_root, args)
    
    print("\n" + "=" * 60)
    sys.exit(0)

