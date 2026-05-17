#!/usr/bin/env python3
"""
Example usage of ExcelMarketResearchS2LEnv

This script demonstrates how to use the Excel Market Research S2L environment.
"""

import sys
import tempfile
from pathlib import Path

# Add gem to path
GEM_PATH = Path(__file__).parent.parent.parent
sys.path.insert(0, str(GEM_PATH))

from gem.envs.excel_market_research_s2l import ExcelMarketResearchS2LEnv


def example_basic_usage():
    """Basic usage example"""
    print("=" * 60)
    print("Example 1: Basic Usage")
    print("=" * 60)
    
    # Create a temporary directory for the task
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"\nTask directory: {tmpdir}")
        
        # Create environment with easy difficulty
        env = ExcelMarketResearchS2LEnv(
            task_dir=tmpdir,
            difficulty="easy",
            seed=42,
            verbose=True
        )
        
        # Reset environment and get task instructions
        instruction, info = env.reset()
        
        print("\n" + "=" * 60)
        print("Task Instructions:")
        print("=" * 60)
        print(instruction)
        
        # Check what files were created
        agent_workspace = Path(tmpdir) / "agent_workspace"
        print("\n" + "=" * 60)
        print("Files in Agent Workspace:")
        print("=" * 60)
        for file in agent_workspace.iterdir():
            if file.is_file():
                size = file.stat().st_size
                print(f"  - {file.name} ({size:,} bytes)")
        
        # At this point, an agent would:
        # 1. Read Market_Data.xlsx
        # 2. Process the data
        # 3. Calculate growth rates
        # 4. Save results to growth_rate.xlsx
        
        # For demonstration, we'll just show that we can call step()
        # (in real usage, the agent would create the output file first)
        print("\n" + "=" * 60)
        print("Note: In real usage, agent would process data here")
        print("=" * 60)


def example_different_difficulties():
    """Example showing different difficulty levels"""
    print("\n" + "=" * 60)
    print("Example 2: Different Difficulty Levels")
    print("=" * 60)
    
    difficulties = ["easy", "medium", "hard", "expert"]
    
    for difficulty in difficulties:
        print(f"\n{difficulty.upper()}:")
        
        with tempfile.TemporaryDirectory() as tmpdir:
            env = ExcelMarketResearchS2LEnv(
                task_dir=tmpdir,
                difficulty=difficulty,
                seed=42,
                verbose=False
            )
            
            # Check generated files
            agent_workspace = Path(tmpdir) / "agent_workspace"
            groundtruth = Path(tmpdir) / "groundtruth_workspace"
            
            # Count data points in groundtruth
            if (groundtruth / "metadata.json").exists():
                import json
                with open(groundtruth / "metadata.json", 'r') as f:
                    metadata = json.load(f)
                
                print(f"  Raw categories: {len(metadata.get('raw_categories', []))}")
                print(f"  Target category: {metadata.get('target_category', 'N/A')}")
                print(f"  Years: {metadata.get('start_year', 'N/A')} - {metadata.get('end_year', 'N/A')}")


def example_custom_parameters():
    """Example with custom parameters"""
    print("\n" + "=" * 60)
    print("Example 3: Custom Parameters")
    print("=" * 60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create environment with custom parameters
        env = ExcelMarketResearchS2LEnv(
            task_dir=tmpdir,
            seed=100,  # Different seed for different data
            start_year=2015,
            num_years=8,
            num_raw_categories=7,
            num_internal_categories=4,
            verbose=True
        )
        
        print(f"\nCustom configuration:")
        print(f"  Seed: 100")
        print(f"  Years: 2015-2022 (8 years)")
        print(f"  Raw categories: 7")
        print(f"  Internal categories: 4")
        
        # Check generated files
        agent_workspace = Path(tmpdir) / "agent_workspace"
        print(f"\nGenerated files:")
        for file in agent_workspace.iterdir():
            if file.is_file():
                print(f"  - {file.name}")


def example_file_inspection():
    """Example showing how to inspect generated files"""
    print("\n" + "=" * 60)
    print("Example 4: Inspecting Generated Files")
    print("=" * 60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        env = ExcelMarketResearchS2LEnv(
            task_dir=tmpdir,
            difficulty="easy",
            seed=42,
            verbose=False
        )
        
        agent_workspace = Path(tmpdir) / "agent_workspace"
        groundtruth = Path(tmpdir) / "groundtruth_workspace"
        
        # Read task-specific instructions
        task_specific = agent_workspace / "task_specific.md"
        if task_specific.exists():
            print("\nTask-Specific Instructions:")
            print("-" * 60)
            with open(task_specific, 'r') as f:
                print(f.read())
        
        # Show groundtruth metadata
        metadata_file = groundtruth / "metadata.json"
        if metadata_file.exists():
            print("\nGroundtruth Metadata:")
            print("-" * 60)
            import json
            with open(metadata_file, 'r') as f:
                metadata = json.load(f)
            for key, value in metadata.items():
                if isinstance(value, list) and len(value) > 5:
                    print(f"  {key}: [{', '.join(map(str, value[:3]))}, ... ({len(value)} total)]")
                else:
                    print(f"  {key}: {value}")


def main():
    """Run all examples"""
    print("=" * 60)
    print("EXCEL MARKET RESEARCH S2L ENVIRONMENT - USAGE EXAMPLES")
    print("=" * 60)
    
    try:
        example_basic_usage()
        example_different_difficulties()
        example_custom_parameters()
        example_file_inspection()
        
        print("\n" + "=" * 60)
        print("All examples completed successfully!")
        print("=" * 60)
        return 0
        
    except Exception as e:
        print(f"\n❌ Example failed: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())

