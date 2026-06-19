#!/usr/bin/env python3
"""
Verification script for WoocommerceNewWelcomeS2LEnv implementation

This script verifies that all required files are present and the implementation
follows the expected structure.
"""

import sys
from pathlib import Path


def verify_file_structure():
    """Verify that all required files and directories are present"""
    print("=" * 80)
    print("Verifying File Structure")
    print("=" * 80)
    
    env_dir = Path(__file__).parent
    
    required_files = {
        "Core Implementation": [
            "woocommerce_new_welcome_s2l.py",
            "__init__.py",
        ],
        "Documentation": [
            "README.md",
            "IMPLEMENTATION_SUMMARY.md",
        ],
        "Testing": [
            "simple_test.py",
            "test_env.py",
            "verify_implementation.py",
        ],
        "Configuration": [
            "emails_config.json",
        ],
    }
    
    required_dirs = {
        "Supporting Directories": [
            "preprocess",
            "evaluation",
            "initial_workspace",
        ],
    }
    
    all_present = True
    
    # Check files
    for category, files in required_files.items():
        print(f"\n{category}:")
        for file_name in files:
            file_path = env_dir / file_name
            exists = file_path.exists()
            status = "✓" if exists else "✗"
            size = f"({file_path.stat().st_size:,} bytes)" if exists else ""
            print(f"  {status} {file_name} {size}")
            if not exists:
                all_present = False
    
    # Check directories
    for category, dirs in required_dirs.items():
        print(f"\n{category}:")
        for dir_name in dirs:
            dir_path = env_dir / dir_name
            exists = dir_path.exists()
            status = "✓" if exists else "✗"
            
            if exists:
                # Count files in directory
                file_count = len(list(dir_path.rglob("*.py"))) + len(list(dir_path.rglob("*.json"))) + len(list(dir_path.rglob("*.md")))
                print(f"  {status} {dir_name}/ ({file_count} files)")
            else:
                print(f"  {status} {dir_name}/")
                all_present = False
    
    return all_present


def verify_imports():
    """Verify that the environment can be imported"""
    print("\n" + "=" * 80)
    print("Verifying Imports")
    print("=" * 80)
    
    try:
        # Add parent directory to path
        env_dir = Path(__file__).parent
        sys.path.insert(0, str(env_dir.parent.parent))
        
        from gem.envs.woocommerce_new_welcome_s2l import WoocommerceNewWelcomeS2LEnv
        print("✓ Successfully imported WoocommerceNewWelcomeS2LEnv")
        
        # Check class attributes
        expected_methods = ["__init__", "reset", "step", "_get_instructions"]
        for method in expected_methods:
            has_method = hasattr(WoocommerceNewWelcomeS2LEnv, method)
            status = "✓" if has_method else "✗"
            print(f"  {status} Method '{method}' present")
            if not has_method:
                return False
        
        return True
        
    except Exception as e:
        print(f"✗ Import failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def verify_class_structure():
    """Verify the class structure and inheritance"""
    print("\n" + "=" * 80)
    print("Verifying Class Structure")
    print("=" * 80)
    
    try:
        env_dir = Path(__file__).parent
        sys.path.insert(0, str(env_dir.parent.parent))
        
        from gem.envs.woocommerce_new_welcome_s2l import WoocommerceNewWelcomeS2LEnv
        from gem.core import Env
        
        # Check inheritance
        is_subclass = issubclass(WoocommerceNewWelcomeS2LEnv, Env)
        status = "✓" if is_subclass else "✗"
        print(f"{status} WoocommerceNewWelcomeS2LEnv inherits from Env")
        
        if not is_subclass:
            return False
        
        # Check __init__ parameters
        import inspect
        sig = inspect.signature(WoocommerceNewWelcomeS2LEnv.__init__)
        params = list(sig.parameters.keys())
        
        expected_params = [
            "self", "task_dir", "total_orders", "first_time_customers",
            "noise_outside_window", "noise_incomplete", "seed", "difficulty", "verbose"
        ]
        
        print("\n✓ __init__ parameters:")
        for param in expected_params:
            has_param = param in params
            status = "✓" if has_param else "✗"
            print(f"  {status} {param}")
            if not has_param and param != "self":
                return False
        
        return True
        
    except Exception as e:
        print(f"✗ Class structure verification failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def verify_preprocessing_files():
    """Verify that preprocessing files are present"""
    print("\n" + "=" * 80)
    print("Verifying Preprocessing Files")
    print("=" * 80)
    
    env_dir = Path(__file__).parent
    preprocess_dir = env_dir / "preprocess"
    
    required_files = [
        "main.py",
        "customers_data.json",
        "woocommerce_data.json",
        "DIFFICULTY_CONTROL.md",
    ]
    
    all_present = True
    for file_name in required_files:
        file_path = preprocess_dir / file_name
        exists = file_path.exists()
        status = "✓" if exists else "✗"
        print(f"{status} preprocess/{file_name}")
        if not exists:
            all_present = False
    
    return all_present


def verify_evaluation_files():
    """Verify that evaluation files are present"""
    print("\n" + "=" * 80)
    print("Verifying Evaluation Files")
    print("=" * 80)
    
    env_dir = Path(__file__).parent
    evaluation_dir = env_dir / "evaluation"
    
    required_files = [
        "main.py",
    ]
    
    all_present = True
    for file_name in required_files:
        file_path = evaluation_dir / file_name
        exists = file_path.exists()
        status = "✓" if exists else "✗"
        print(f"{status} evaluation/{file_name}")
        if not exists:
            all_present = False
    
    return all_present


def verify_workspace_files():
    """Verify that initial workspace files are present"""
    print("\n" + "=" * 80)
    print("Verifying Initial Workspace Files")
    print("=" * 80)
    
    env_dir = Path(__file__).parent
    workspace_dir = env_dir / "initial_workspace"
    
    required_files = [
        "admin_credentials.txt",
        "welcome_email_template.md",
        "woocommerce_orders.json",
    ]
    
    all_present = True
    for file_name in required_files:
        file_path = workspace_dir / file_name
        exists = file_path.exists()
        status = "✓" if exists else "✗"
        print(f"{status} initial_workspace/{file_name}")
        if not exists:
            all_present = False
    
    return all_present


def main():
    """Run all verification checks"""
    print("=" * 80)
    print("WoocommerceNewWelcomeS2LEnv - Implementation Verification")
    print("=" * 80)
    print()
    
    checks = [
        ("File Structure", verify_file_structure),
        ("Imports", verify_imports),
        ("Class Structure", verify_class_structure),
        ("Preprocessing Files", verify_preprocessing_files),
        ("Evaluation Files", verify_evaluation_files),
        ("Workspace Files", verify_workspace_files),
    ]
    
    results = []
    
    for check_name, check_func in checks:
        try:
            result = check_func()
            results.append((check_name, result))
        except Exception as e:
            print(f"\n✗ Check '{check_name}' crashed: {e}")
            import traceback
            traceback.print_exc()
            results.append((check_name, False))
    
    # Summary
    print("\n" + "=" * 80)
    print("Verification Summary")
    print("=" * 80)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for check_name, result in results:
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"{check_name}: {status}")
    
    print("\n" + "=" * 80)
    print(f"Results: {passed}/{total} checks passed")
    
    if passed == total:
        print("\n🎉 IMPLEMENTATION VERIFIED!")
        print("\nThe WoocommerceNewWelcomeS2LEnv environment has been successfully")
        print("implemented with all required files and proper structure.")
        print("\nNext steps:")
        print("  1. Run simple_test.py to test basic functionality")
        print("  2. Run test_env.py for comprehensive testing")
        print("  3. Integrate with GEM framework")
    else:
        print(f"\n⚠️  {total - passed} check(s) failed")
        print("\nPlease fix the issues above before proceeding.")
    
    print("=" * 80)
    
    return passed == total


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)

