#!/usr/bin/env python3
"""
Example usage of NhlB2bAnalysisS2LEnv environment.

This script demonstrates how to:
1. Create and initialize the environment
2. Reset the environment (runs preprocessing)
3. Get task instructions
4. Simulate agent execution (placeholder)
5. Evaluate results (runs evaluation)
"""

import sys
import tempfile
from pathlib import Path

# Add parent directory to path for imports
env_dir = Path(__file__).parent
sys.path.insert(0, str(env_dir.parent.parent.parent))


def example_basic_usage():
    """Example: Basic environment usage with default parameters"""
    print("=" * 80)
    print("Example 1: Basic Usage")
    print("=" * 80)
    
    # Note: This requires the gem framework to be properly installed
    # and may not work with Python < 3.9 due to type hint compatibility
    
    try:
        from gem.envs.nhl_b2b_analysis_s2l import NhlB2bAnalysisS2LEnv
        
        with tempfile.TemporaryDirectory() as tmpdir:
            print(f"\nCreating environment in: {tmpdir}")
            
            # Create environment with small dataset for quick testing
            env = NhlB2bAnalysisS2LEnv(
                task_dir=tmpdir,
                num_games=50,
                num_teams=4,
                seed=42,
                verbose=True
            )
            print("✓ Environment created")
            
            # Reset environment (runs preprocessing)
            print("\nResetting environment (this will run preprocessing)...")
            instruction, info = env.reset()
            print("✓ Environment reset completed")
            
            # Display task instruction
            print("\n" + "-" * 80)
            print("Task Instruction:")
            print("-" * 80)
            print(instruction[:300] + "...\n")
            
            # At this point, an AI agent would:
            # 1. Read NHL schedule from Google Sheets
            # 2. Analyze back-to-back games
            # 3. Save results to Google Sheets and CSV
            
            print("(Agent would execute task here)")
            
            # After agent completes the task:
            # observation, reward, terminated, truncated, info = env.step("claim_done")
            # print(f"\nTask completed with reward: {reward}")
            
    except ImportError as e:
        print(f"\n✗ Could not import environment: {e}")
        print("   Note: This requires the gem framework to be installed")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()


def example_difficulty_presets():
    """Example: Using difficulty presets"""
    print("\n" + "=" * 80)
    print("Example 2: Difficulty Presets")
    print("=" * 80)
    
    difficulties = {
        "easy": "50 games, 10 teams (first 2 weeks)",
        "medium": "150 games, 16 teams (first month)",
        "hard": "400 games, 24 teams (first quarter)",
        "expert": "656 games, 32 teams (half season)",
        "extreme": "1312 games, 32 teams (full season)",
    }
    
    print("\nAvailable difficulty presets:")
    for difficulty, description in difficulties.items():
        print(f"  - {difficulty:8s}: {description}")
    
    try:
        from gem.envs.nhl_b2b_analysis_s2l import NhlB2bAnalysisS2LEnv
        
        # Example: Create environment with medium difficulty
        with tempfile.TemporaryDirectory() as tmpdir:
            print(f"\nCreating environment with 'medium' difficulty...")
            
            env = NhlB2bAnalysisS2LEnv(
                task_dir=tmpdir,
                difficulty="medium",
                seed=42,
                verbose=False  # Disable verbose for cleaner output
            )
            print("✓ Environment created with medium difficulty")
            print(f"   Parameters: {env.num_games} games, {env.num_teams} teams")
            
    except ImportError as e:
        print(f"\n✗ Could not import environment: {e}")
    except Exception as e:
        print(f"\n✗ Error: {e}")


def example_custom_parameters():
    """Example: Using custom parameters"""
    print("\n" + "=" * 80)
    print("Example 3: Custom Parameters")
    print("=" * 80)
    
    try:
        from gem.envs.nhl_b2b_analysis_s2l import NhlB2bAnalysisS2LEnv
        
        with tempfile.TemporaryDirectory() as tmpdir:
            print(f"\nCreating environment with custom parameters...")
            
            # Custom configuration
            env = NhlB2bAnalysisS2LEnv(
                task_dir=tmpdir,
                num_games=100,       # Custom number of games
                num_teams=8,         # Custom number of teams
                start_date="2024-10-15",  # Custom start date
                seed=123,            # Custom seed
                verbose=False
            )
            print("✓ Environment created with custom parameters")
            print(f"   Games: {env.num_games}")
            print(f"   Teams: {env.num_teams}")
            print(f"   Start Date: {env.start_date}")
            print(f"   Seed: {env.seed}")
            
    except ImportError as e:
        print(f"\n✗ Could not import environment: {e}")
    except Exception as e:
        print(f"\n✗ Error: {e}")


def example_task_instruction():
    """Example: Accessing task instruction without full reset"""
    print("\n" + "=" * 80)
    print("Example 4: Task Instruction")
    print("=" * 80)
    
    try:
        from gem.envs.nhl_b2b_analysis_s2l import NhlB2bAnalysisS2LEnv
        
        with tempfile.TemporaryDirectory() as tmpdir:
            print(f"\nCreating environment...")
            
            env = NhlB2bAnalysisS2LEnv(
                task_dir=tmpdir,
                num_games=50,
                num_teams=4,
                seed=42,
                verbose=False
            )
            
            # Get task instruction
            instruction = env._get_instructions()
            
            print("\nTask Instruction:")
            print("-" * 80)
            print(instruction)
            print("-" * 80)
            
            # Check for key phrases
            print("\nKey phrases in instruction:")
            key_phrases = [
                "back-to-back games",
                "NHL 2024–2025",
                "nhl_b2b_analysis",
                "Team,HA,AH,HH,AA,Total"
            ]
            
            for phrase in key_phrases:
                if phrase in instruction:
                    print(f"  ✓ '{phrase}'")
                else:
                    print(f"  ✗ '{phrase}' (NOT FOUND)")
            
    except ImportError as e:
        print(f"\n✗ Could not import environment: {e}")
    except Exception as e:
        print(f"\n✗ Error: {e}")


def example_parallel_execution():
    """Example: Parallel execution considerations"""
    print("\n" + "=" * 80)
    print("Example 5: Parallel Execution Considerations")
    print("=" * 80)
    
    print("\nThe environment supports parallel execution:")
    print("  - Each instance uses a unique logger name (based on id(self))")
    print("  - All files are stored in task_dir (separate for each instance)")
    print("  - Database directories are task-specific")
    print("  - No shared state between instances")
    print("  - Module imports use unique names to avoid conflicts")
    
    print("\nExample of creating multiple instances:")
    
    try:
        from gem.envs.nhl_b2b_analysis_s2l import NhlB2bAnalysisS2LEnv
        
        # Create multiple instances
        instances = []
        task_dirs = []
        
        for i in range(3):
            tmpdir = tempfile.mkdtemp()
            task_dirs.append(tmpdir)
            
            env = NhlB2bAnalysisS2LEnv(
                task_dir=tmpdir,
                num_games=50,
                num_teams=4,
                seed=42 + i,  # Different seed for each instance
                verbose=False
            )
            instances.append(env)
            print(f"  ✓ Instance {i+1} created in {tmpdir}")
        
        print(f"\n✓ Created {len(instances)} independent instances")
        print("  Each instance has:")
        print("    - Unique task directory")
        print("    - Unique logger")
        print("    - Independent database")
        
        # Cleanup
        import shutil
        for tmpdir in task_dirs:
            shutil.rmtree(tmpdir)
        print("\n✓ Cleanup completed")
        
    except ImportError as e:
        print(f"\n✗ Could not import environment: {e}")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()


def main():
    """Run all examples"""
    print("\n" + "=" * 80)
    print("NHL B2B Analysis S2L Environment - Usage Examples")
    print("=" * 80)
    print("\nNote: These examples require the gem framework to be installed.")
    print("      Some examples may not work with Python < 3.9 due to type hints.")
    
    examples = [
        ("Basic Usage", example_basic_usage),
        ("Difficulty Presets", example_difficulty_presets),
        ("Custom Parameters", example_custom_parameters),
        ("Task Instruction", example_task_instruction),
        ("Parallel Execution", example_parallel_execution),
    ]
    
    for name, example_func in examples:
        try:
            example_func()
        except KeyboardInterrupt:
            print("\n\nInterrupted by user")
            break
        except Exception as e:
            print(f"\n✗ Example '{name}' failed: {e}")
            import traceback
            traceback.print_exc()
    
    print("\n" + "=" * 80)
    print("Examples completed")
    print("=" * 80)


if __name__ == "__main__":
    main()

