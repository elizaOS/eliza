#!/usr/bin/env python3
"""
Example usage of FilterLowSellingProductsS2LEnv

This script demonstrates how to use the FilterLowSellingProductsS2LEnv
in different scenarios and configurations.
"""

import sys
import tempfile
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from gem.envs.filter_low_selling_products_s2l import FilterLowSellingProductsS2LEnv


def example_basic_usage():
    """Basic usage example"""
    print("=" * 80)
    print("Example 1: Basic Usage")
    print("=" * 80)
    
    # Create a temporary directory for this example
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"\nTask directory: {temp_dir}\n")
        
        # Initialize environment
        env = FilterLowSellingProductsS2LEnv(
            task_dir=temp_dir,
            num_low_selling=3,
            num_normal_selling=2,
            num_subscribers=2,
            seed=42,
            verbose=True
        )
        
        # Get instructions
        instruction = env._get_instructions()
        print(f"\nTask Instruction:")
        print("-" * 80)
        print(instruction)
        print("-" * 80)
        
        print("\n✓ Environment initialized and ready for agent")
        print(f"✓ Agent workspace: {env.agent_workspace}")
        print(f"✓ WooCommerce DB: {env.woocommerce_data_dir}")
        print(f"✓ Email DB: {env.email_data_dir}")


def example_difficulty_preset():
    """Example using difficulty presets"""
    print("\n" + "=" * 80)
    print("Example 2: Using Difficulty Presets")
    print("=" * 80)
    
    difficulties = ["easy", "medium", "hard"]
    
    for difficulty in difficulties:
        print(f"\n{'─' * 40}")
        print(f"Difficulty: {difficulty.upper()}")
        print('─' * 40)
        
        with tempfile.TemporaryDirectory() as temp_dir:
            env = FilterLowSellingProductsS2LEnv(
                task_dir=temp_dir,
                difficulty=difficulty,
                seed=42,
                verbose=False
            )
            
            print(f"✓ Environment created with {difficulty} difficulty")
            print(f"  - Low-selling products: (varies by preset)")
            print(f"  - Normal products: (varies by preset)")
            print(f"  - Subscribers: (varies by preset)")


def example_custom_configuration():
    """Example with custom configuration"""
    print("\n" + "=" * 80)
    print("Example 3: Custom Configuration")
    print("=" * 80)
    
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"\nTask directory: {temp_dir}\n")
        
        # Custom configuration
        env = FilterLowSellingProductsS2LEnv(
            task_dir=temp_dir,
            num_low_selling=10,      # More low-selling products
            num_normal_selling=15,    # More normal products
            num_subscribers=5,        # More subscribers
            seed=123,                 # Different seed
            verbose=True
        )
        
        print("\n✓ Custom environment configured:")
        print(f"  - Low-selling products: {env.num_low_selling}")
        print(f"  - Normal products: {env.num_normal_selling}")
        print(f"  - Subscribers: {env.num_subscribers}")
        print(f"  - Seed: {env.seed}")


def example_with_mock_agent():
    """Example showing full workflow with mock agent"""
    print("\n" + "=" * 80)
    print("Example 4: Full Workflow (Mock Agent)")
    print("=" * 80)
    
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"\nTask directory: {temp_dir}\n")
        
        # Step 1: Initialize environment
        print("Step 1: Initialize Environment")
        print("-" * 40)
        env = FilterLowSellingProductsS2LEnv(
            task_dir=temp_dir,
            num_low_selling=2,
            num_normal_selling=2,
            num_subscribers=2,
            seed=42,
            verbose=False
        )
        print("✓ Environment initialized")
        
        # Step 2: Get task instruction
        print("\nStep 2: Get Task Instruction")
        print("-" * 40)
        instruction, _ = env.reset()
        print(f"Instruction received: {len(instruction)} characters")
        print("✓ Reset completed (preprocessing done)")
        
        # Step 3: Mock agent execution
        print("\nStep 3: Mock Agent Execution")
        print("-" * 40)
        print("Mock agent would:")
        print("  1. Query WooCommerce for products")
        print("  2. Identify low-selling products")
        print("  3. Move products to Clearance category")
        print("  4. Send notification emails to subscribers")
        print("✓ Mock execution complete")
        
        # Step 4: Evaluate (would normally be called after agent completes)
        print("\nStep 4: Evaluation")
        print("-" * 40)
        print("Note: Evaluation would check:")
        print("  - Product categorization in WooCommerce")
        print("  - Email notifications sent to subscribers")
        print("  - Email content includes product info")
        print("✓ Evaluation criteria defined")
        
        # In real usage, you would call:
        # observation, reward, terminated, truncated, info = env.step("claim_done")
        
        print("\n✓ Full workflow demonstrated")


def example_parallel_execution():
    """Example showing parallel execution capability"""
    print("\n" + "=" * 80)
    print("Example 5: Parallel Execution Capability")
    print("=" * 80)
    
    print("\nCreating multiple environment instances...")
    
    envs = []
    temp_dirs = []
    
    try:
        # Create 3 parallel environments
        for i in range(3):
            temp_dir = tempfile.mkdtemp()
            temp_dirs.append(temp_dir)
            
            env = FilterLowSellingProductsS2LEnv(
                task_dir=temp_dir,
                num_low_selling=2,
                num_normal_selling=2,
                num_subscribers=2,
                seed=42 + i,  # Different seed for each
                verbose=False
            )
            envs.append(env)
            print(f"✓ Environment {i+1} created (seed={42+i})")
        
        print(f"\n✓ Successfully created {len(envs)} parallel environments")
        print("  Each has independent:")
        print("    - Task directory")
        print("    - Databases (WooCommerce + Email)")
        print("    - Groundtruth data")
        print("    - Logger")
        
    finally:
        # Cleanup
        import shutil
        for temp_dir in temp_dirs:
            try:
                shutil.rmtree(temp_dir)
            except:
                pass


def example_inspect_workspace():
    """Example showing how to inspect generated workspace"""
    print("\n" + "=" * 80)
    print("Example 6: Inspecting Generated Workspace")
    print("=" * 80)
    
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"\nTask directory: {temp_dir}\n")
        
        env = FilterLowSellingProductsS2LEnv(
            task_dir=temp_dir,
            num_low_selling=2,
            num_normal_selling=2,
            num_subscribers=2,
            seed=42,
            verbose=False
        )
        
        # Inspect agent workspace
        print("Agent Workspace Contents:")
        print("-" * 40)
        agent_ws = Path(env.agent_workspace)
        if agent_ws.exists():
            for item in sorted(agent_ws.iterdir()):
                if item.is_file():
                    size = item.stat().st_size
                    print(f"  📄 {item.name} ({size} bytes)")
                elif item.is_dir():
                    count = len(list(item.iterdir()))
                    print(f"  📁 {item.name}/ ({count} items)")
        
        # Inspect databases
        print("\nDatabase Directories:")
        print("-" * 40)
        wc_db = Path(env.woocommerce_data_dir)
        if wc_db.exists():
            wc_files = list(wc_db.glob("*.json"))
            print(f"  🛒 WooCommerce: {len(wc_files)} database files")
        
        email_db = Path(env.email_data_dir)
        if email_db.exists():
            email_files = list(email_db.glob("**/*.json"))
            print(f"  📧 Email: {len(email_files)} database files")
        
        # Inspect groundtruth
        print("\nGroundtruth Workspace:")
        print("-" * 40)
        gt_ws = Path(temp_dir) / "groundtruth_workspace"
        if gt_ws.exists():
            for item in sorted(gt_ws.iterdir()):
                if item.is_file():
                    print(f"  ✓ {item.name}")


def main():
    """Run all examples"""
    print("\n" + "=" * 80)
    print("FilterLowSellingProductsS2LEnv - Usage Examples")
    print("=" * 80)
    
    examples = [
        ("Basic Usage", example_basic_usage),
        ("Difficulty Presets", example_difficulty_preset),
        ("Custom Configuration", example_custom_configuration),
        ("Full Workflow", example_with_mock_agent),
        ("Parallel Execution", example_parallel_execution),
        ("Inspect Workspace", example_inspect_workspace),
    ]
    
    for i, (name, func) in enumerate(examples, 1):
        try:
            func()
        except Exception as e:
            print(f"\n❌ Example {i} failed: {e}")
            import traceback
            traceback.print_exc()
    
    print("\n" + "=" * 80)
    print("All Examples Completed")
    print("=" * 80)
    print("\nFor more information:")
    print("  - See README.md for detailed documentation")
    print("  - Run simple_test.py for basic tests")
    print("  - Run test_env.py for comprehensive tests")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()

