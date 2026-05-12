#!/usr/bin/env python3
"""
Simple test script to verify MachineOperatingS2LEnv can be imported and initialized.
"""

import sys
import tempfile
import shutil
from pathlib import Path

# Add gem root directory to path for imports
gem_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(gem_root))

def test_import():
    """Test that the environment can be imported"""
    print("Testing import...")
    try:
        from gem.envs.machine_operating_s2l import MachineOperatingS2LEnv
        print("✓ Import successful")
        return True
    except ImportError as e:
        print(f"✗ Import failed: {e}")
        return False

def test_initialization():
    """Test that the environment can be initialized"""
    print("\nTesting initialization...")
    try:
        from gem.envs.machine_operating_s2l import MachineOperatingS2LEnv
        
        # Create a temporary directory for testing
        temp_dir = tempfile.mkdtemp(prefix="test_machine_operating_")
        print(f"  Using temporary directory: {temp_dir}")
        
        try:
            # Initialize environment with minimal settings
            env = MachineOperatingS2LEnv(
                task_dir=temp_dir,
                hours=1,  # Minimal data
                interval_minutes=10,
                anomaly_rate=0.1,
                difficulty="easy",
                total_machines=10,  # Only 10 machines for testing
                total_sensors="3",  # Only 3 sensor types for testing
                seed=42,
                verbose=False
            )
            print("✓ Initialization successful")
            print(f"  Agent workspace: {env.agent_workspace}")
            print(f"  Data directory: {env.data_dir}")
            
            # Check that directories were created
            if env.agent_workspace.exists():
                print("✓ Agent workspace created")
            else:
                print("✗ Agent workspace not created")
                return False
            
            return True
            
        finally:
            # Clean up temporary directory
            if Path(temp_dir).exists():
                shutil.rmtree(temp_dir)
                print(f"  Cleaned up temporary directory")
                
    except Exception as e:
        print(f"✗ Initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_reset():
    """Test that the environment reset works (preprocessing pipeline)"""
    print("\nTesting reset (preprocessing)...")
    print("Note: This will generate data and may take some time...")
    
    try:
        from gem.envs.machine_operating_s2l import MachineOperatingS2LEnv
        
        # Create a temporary directory for testing
        temp_dir = tempfile.mkdtemp(prefix="test_machine_operating_reset_")
        print(f"  Using temporary directory: {temp_dir}")
        
        try:
            # Initialize environment with minimal settings for faster testing
            env = MachineOperatingS2LEnv(
                task_dir=temp_dir,
                hours=1,  # Only 1 hour of data
                interval_minutes=10,  # 10 minute intervals
                anomaly_rate=0.1,
                difficulty="easy",
                total_machines=10,  # Only 10 machines for faster testing
                total_sensors="3",  # Only 3 sensor types for faster testing
                seed=42,
                verbose=True  # Show preprocessing output
            )
            
            print("\n  Starting reset (this may take 30-60 seconds)...")
            instruction, info = env.reset()
            
            print("\n✓ Reset successful")
            print(f"  Instruction length: {len(instruction)} characters")
            print(f"  Info: {info}")
            
            # Check that key files were created
            checks = [
                (env.agent_workspace / "machine_operating_parameters.xlsx", "Parameters Excel"),
                (Path(temp_dir) / "local_db" / "google_cloud", "Google Cloud DB"),
                (Path(temp_dir) / "groundtruth_workspace" / "anomaly_report.csv", "Groundtruth report"),
            ]
            
            all_good = True
            for path, description in checks:
                if path.exists():
                    print(f"✓ {description} exists: {path}")
                else:
                    print(f"✗ {description} missing: {path}")
                    all_good = False
            
            return all_good
            
        finally:
            # Clean up temporary directory
            if Path(temp_dir).exists():
                shutil.rmtree(temp_dir)
                print(f"\n  Cleaned up temporary directory")
                
    except Exception as e:
        print(f"✗ Reset failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """Run all tests"""
    print("=" * 60)
    print("Machine Operating S2L Environment Tests")
    print("=" * 60)
    
    results = []
    
    # Test 1: Import
    results.append(("Import", test_import()))
    
    # Test 2: Initialization
    results.append(("Initialization", test_initialization()))
    
    # Test 3: Reset (commented out by default as it takes time)
    # Uncomment to test full preprocessing pipeline
    # results.append(("Reset/Preprocessing", test_reset()))
    
    # Print summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    for name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"{name}: {status}")
    
    all_passed = all(passed for _, passed in results)
    
    if all_passed:
        print("\n✓ All tests passed!")
        return 0
    else:
        print("\n✗ Some tests failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())

