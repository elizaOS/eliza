#!/usr/bin/env python3
"""
Example usage of PayableInvoiceCheckerS2L environment.

This script demonstrates how to:
1. Initialize the environment
2. Reset to get initial task instruction
3. Simulate agent actions
4. Evaluate task completion
"""

import sys
import tempfile
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from gem.envs.payable_invoice_checker_s2l import PayableInvoiceCheckerS2LEnv


def example_basic_usage():
    """Demonstrate basic environment usage."""
    print("\n" + "=" * 80)
    print("EXAMPLE 1: Basic Environment Usage")
    print("=" * 80)
    
    # Create temporary directory for this example
    temp_dir = tempfile.mkdtemp(prefix="payable_invoice_example_")
    
    try:
        # Initialize environment with default settings
        print("\n1. Initializing environment...")
        env = PayableInvoiceCheckerS2LEnv(
            task_dir=temp_dir,
            num_invoices=10,
            num_interference=500,
            seed=42,
            verbose=True
        )
        
        # Get task instruction
        print("\n2. Getting task instruction...")
        instruction, info = env.reset()
        print(f"\nTask Instruction:\n{instruction}")
        
        print("\n3. Environment is ready for agent actions")
        print(f"   Agent workspace: {env.agent_workspace}")
        print(f"   Snowflake database: {env.snowflake_data_dir}")
        print(f"   Email database: {env.email_data_dir}")
        
        # At this point, the agent would:
        # - Read PDF files from agent_workspace/files/
        # - Extract invoice data
        # - Update Snowflake tables
        # - Send emails to purchasing managers
        # - Call env.step("claim_done") when finished
        
        print("\n4. Agent performs actions...")
        print("   (In a real scenario, agent would process invoices here)")
        
        # Simulate agent claiming task is done
        # Note: This will fail evaluation since we didn't actually do anything
        print("\n5. Agent claims task is done...")
        observation, reward, terminated, truncated, info = env.step("claim_done")
        
        print(f"\n6. Evaluation result:")
        print(f"   Reward: {reward}")
        print(f"   Success: {info.get('success', False)}")
        print(f"   Terminated: {terminated}")
        
    finally:
        # Note: In production, you may want to keep task_dir for debugging
        print(f"\nTask directory preserved at: {temp_dir}")
        print("(You can manually delete it when done)")


def example_difficulty_presets():
    """Demonstrate different difficulty levels."""
    print("\n" + "=" * 80)
    print("EXAMPLE 2: Using Difficulty Presets")
    print("=" * 80)
    
    difficulties = [
        ("easy", "5 invoices, 100 interference records"),
        ("medium", "15 invoices, 1000 interference records"),
        ("hard", "30 invoices, 3000 interference records"),
    ]
    
    for difficulty, description in difficulties:
        temp_dir = tempfile.mkdtemp(prefix=f"payable_invoice_{difficulty}_")
        
        try:
            print(f"\n{difficulty.upper()} Difficulty: {description}")
            
            env = PayableInvoiceCheckerS2LEnv(
                task_dir=temp_dir,
                difficulty=difficulty,
                verbose=False  # Reduce output for demonstration
            )
            
            instruction, info = env.reset()
            
            print(f"✅ Environment initialized successfully")
            print(f"   Workspace: {env.agent_workspace}")
            
        finally:
            print(f"   Task directory: {temp_dir}")


def example_custom_configuration():
    """Demonstrate custom configuration."""
    print("\n" + "=" * 80)
    print("EXAMPLE 3: Custom Configuration")
    print("=" * 80)
    
    temp_dir = tempfile.mkdtemp(prefix="payable_invoice_custom_")
    
    try:
        print("\nCreating environment with custom parameters...")
        
        env = PayableInvoiceCheckerS2LEnv(
            task_dir=temp_dir,
            num_invoices=25,           # Custom number of invoices
            num_interference=1500,     # Custom interference level
            seed=123,                  # Custom random seed
            verbose=True
        )
        
        print("✅ Custom environment initialized")
        print(f"\nConfiguration:")
        print(f"   Invoices: {env.num_invoices}")
        print(f"   Interference: {env.num_interference}")
        print(f"   Seed: {env.seed}")
        print(f"   Task directory: {env.task_dir}")
        
    finally:
        print(f"\nTask directory: {temp_dir}")


def example_parallel_execution():
    """Demonstrate parallel execution support."""
    print("\n" + "=" * 80)
    print("EXAMPLE 4: Parallel Execution Support")
    print("=" * 80)
    
    print("\nThe environment is designed to support parallel execution.")
    print("Each instance uses isolated resources:")
    print("  - Separate task directories")
    print("  - Isolated Snowflake databases")
    print("  - Isolated email databases")
    print("  - Unique module names (no conflicts)")
    
    print("\nYou can safely create multiple instances simultaneously:")
    
    instances = []
    
    for i in range(3):
        temp_dir = tempfile.mkdtemp(prefix=f"payable_invoice_parallel_{i}_")
        
        try:
            print(f"\nCreating instance {i+1}...")
            env = PayableInvoiceCheckerS2LEnv(
                task_dir=temp_dir,
                num_invoices=5,
                num_interference=100,
                seed=42 + i,  # Different seed for each instance
                verbose=False
            )
            instances.append((env, temp_dir))
            print(f"✅ Instance {i+1} created: {temp_dir}")
        except Exception as e:
            print(f"❌ Instance {i+1} failed: {e}")
    
    print(f"\n✅ Created {len(instances)} parallel instances successfully")
    print("Each instance operates independently without conflicts")
    
    # Print summary
    print("\nInstance Summary:")
    for i, (env, temp_dir) in enumerate(instances):
        print(f"  Instance {i+1}:")
        print(f"    Task directory: {temp_dir}")
        print(f"    Agent workspace: {env.agent_workspace}")
        print(f"    Logger name: {env.logger.name}")


def main():
    """Run all examples."""
    print("\n" + "=" * 80)
    print("PAYABLE INVOICE CHECKER S2L - USAGE EXAMPLES")
    print("=" * 80)
    
    # Run examples
    example_basic_usage()
    example_difficulty_presets()
    example_custom_configuration()
    example_parallel_execution()
    
    print("\n" + "=" * 80)
    print("EXAMPLES COMPLETED")
    print("=" * 80)
    print("\nNote: Task directories have been preserved for inspection.")
    print("You can manually delete them when finished:")
    print("  rm -rf /tmp/payable_invoice_*")


if __name__ == "__main__":
    main()




