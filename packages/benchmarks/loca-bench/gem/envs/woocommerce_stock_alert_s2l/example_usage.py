#!/usr/bin/env python3
"""
Example usage of WoocommerceStockAlertS2LEnv.
Demonstrates how to create and use the environment.
"""

import sys
import tempfile
import shutil
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from gem.envs.woocommerce_stock_alert_s2l import WoocommerceStockAlertS2LEnv


def example_basic_usage():
    """Basic usage example"""
    print("=" * 80)
    print("Example 1: Basic Usage")
    print("=" * 80)
    
    # Create temporary directory
    temp_dir = tempfile.mkdtemp(prefix="stock_alert_example_")
    
    try:
        # Create environment with medium difficulty
        print("\n1. Creating environment...")
        env = WoocommerceStockAlertS2LEnv(
            task_dir=temp_dir,
            difficulty="medium",
            verbose=True
        )
        
        # Reset environment (runs preprocessing)
        print("\n2. Resetting environment (running preprocessing)...")
        instruction, info = env.reset()
        
        print("\n3. Task instruction received:")
        print("-" * 80)
        print(instruction)
        print("-" * 80)
        
        print("\n4. Agent workspace contents:")
        for item in env.agent_workspace.iterdir():
            print(f"   - {item.name}")
        
        print("\n5. Simulating agent completion...")
        print("   (In real usage, the agent would now:")
        print("    - Query WooCommerce for products")
        print("    - Identify low-stock products")
        print("    - Update Google Sheets")
        print("    - Send email notifications)")
        
        # Step environment (runs evaluation)
        print("\n6. Running evaluation...")
        observation, reward, terminated, truncated, info = env.step("claim_done")
        
        print("\n7. Evaluation results:")
        print(f"   Success: {info['success']}")
        print(f"   Reward: {reward}")
        print(f"   Terminated: {terminated}")
        
        if not info['success']:
            print(f"   Error: {info.get('error', 'Unknown error')}")
        
        print("\n" + observation)
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        
    finally:
        # Clean up
        if Path(temp_dir).exists():
            shutil.rmtree(temp_dir)
            print(f"\n🧹 Cleaned up: {temp_dir}")


def example_custom_difficulty():
    """Example with custom difficulty parameters"""
    print("\n" + "=" * 80)
    print("Example 2: Custom Difficulty Parameters")
    print("=" * 80)
    
    # Create temporary directory
    temp_dir = tempfile.mkdtemp(prefix="stock_alert_custom_")
    
    try:
        # Create environment with custom parameters
        print("\n1. Creating environment with custom parameters...")
        env = WoocommerceStockAlertS2LEnv(
            task_dir=temp_dir,
            num_low_stock=5,      # 5 products need alerts
            num_normal_stock=15,  # 15 products are normal
            seed=123,             # Custom seed for reproducibility
            verbose=True
        )
        
        print(f"   Configuration:")
        print(f"   - Low-stock products: {env.num_low_stock}")
        print(f"   - Normal-stock products: {env.num_normal_stock}")
        print(f"   - Total products: {env.num_low_stock + env.num_normal_stock}")
        print(f"   - Random seed: {env.seed}")
        
        # Reset environment
        print("\n2. Resetting environment...")
        instruction, info = env.reset()
        
        print("\n✅ Environment ready for agent execution")
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        
    finally:
        # Clean up
        if Path(temp_dir).exists():
            shutil.rmtree(temp_dir)
            print(f"\n🧹 Cleaned up: {temp_dir}")


def example_difficulty_presets():
    """Example showing different difficulty presets"""
    print("\n" + "=" * 80)
    print("Example 3: Difficulty Presets")
    print("=" * 80)
    
    difficulties = {
        "easy": "3 low-stock, 5 normal-stock",
        "medium": "5 low-stock, 10 normal-stock",
        "hard": "10 low-stock, 20 normal-stock",
        "expert": "20 low-stock, 40 normal-stock",
        "extreme": "50 low-stock, 100 normal-stock",
    }
    
    print("\nAvailable difficulty presets:")
    for difficulty, description in difficulties.items():
        print(f"   - {difficulty:8s}: {description}")
    
    # Create one environment as example
    temp_dir = tempfile.mkdtemp(prefix="stock_alert_hard_")
    
    try:
        print("\n1. Creating environment with 'hard' difficulty...")
        env = WoocommerceStockAlertS2LEnv(
            task_dir=temp_dir,
            difficulty="hard",
            verbose=False
        )
        
        print(f"   - Low-stock products: {env.num_low_stock}")
        print(f"   - Normal-stock products: {env.num_normal_stock}")
        
        print("\n✅ Hard difficulty environment created")
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        
    finally:
        if Path(temp_dir).exists():
            shutil.rmtree(temp_dir)


def example_parallel_execution():
    """Example demonstrating parallel execution capability"""
    print("\n" + "=" * 80)
    print("Example 4: Parallel Execution")
    print("=" * 80)
    
    print("\n1. Creating multiple environments...")
    
    environments = []
    temp_dirs = []
    
    try:
        # Create 3 parallel environments
        for i in range(3):
            temp_dir = tempfile.mkdtemp(prefix=f"stock_alert_parallel_{i}_")
            temp_dirs.append(temp_dir)
            
            env = WoocommerceStockAlertS2LEnv(
                task_dir=temp_dir,
                difficulty="easy",
                seed=42 + i,  # Different seed for each
                verbose=False
            )
            
            environments.append(env)
            print(f"   ✅ Environment {i+1} created in {temp_dir}")
        
        print(f"\n2. Successfully created {len(environments)} parallel environments")
        print("   Each environment has:")
        print("   - Independent task directory")
        print("   - Separate database instances")
        print("   - Unique logger instance")
        print("   - No naming conflicts")
        
        print("\n✅ Parallel execution capability verified")
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        
    finally:
        # Clean up all temp directories
        for temp_dir in temp_dirs:
            if Path(temp_dir).exists():
                shutil.rmtree(temp_dir)
        print(f"\n🧹 Cleaned up {len(temp_dirs)} temporary directories")


def main():
    """Run all examples"""
    print("\n🎓 WooCommerce Stock Alert S2L Environment - Usage Examples")
    print("=" * 80)
    
    examples = [
        example_basic_usage,
        example_custom_difficulty,
        example_difficulty_presets,
        example_parallel_execution,
    ]
    
    for i, example_func in enumerate(examples, 1):
        try:
            example_func()
        except KeyboardInterrupt:
            print("\n\n⏸️  Examples interrupted by user")
            break
        except Exception as e:
            print(f"\n❌ Example {i} failed: {e}")
            import traceback
            traceback.print_exc()
    
    print("\n" + "=" * 80)
    print("Examples completed!")
    print("=" * 80)


if __name__ == "__main__":
    main()


