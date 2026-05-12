#!/usr/bin/env python3
"""
Verification script for NhlB2bAnalysisS2LEnv environment setup.
Checks if all required files and directories are in place.
"""

import sys
from pathlib import Path


def check_file_exists(file_path, description):
    """Check if a file exists and report the result"""
    exists = file_path.exists()
    status = "✓" if exists else "✗"
    print(f"{status} {description}: {file_path.name}")
    return exists


def check_directory_exists(dir_path, description):
    """Check if a directory exists and report the result"""
    exists = dir_path.exists() and dir_path.is_dir()
    status = "✓" if exists else "✗"
    print(f"{status} {description}: {dir_path.name}/")
    return exists


def main():
    """Main verification function"""
    print("=" * 80)
    print("NHL B2B Analysis S2L Environment Setup Verification")
    print("=" * 80)
    
    env_dir = Path(__file__).parent
    all_checks_passed = True
    
    # Check main Python files
    print("\n1. Main Python Files:")
    print("-" * 40)
    files_to_check = [
        (env_dir / "nhl_b2b_analysis_s2l.py", "Main environment class"),
        (env_dir / "__init__.py", "Package initialization"),
        (env_dir / "README.md", "Documentation"),
        (env_dir / "task_config.json", "Task configuration"),
    ]
    
    for file_path, description in files_to_check:
        if not check_file_exists(file_path, description):
            all_checks_passed = False
    
    # Check preprocess directory
    print("\n2. Preprocess Directory:")
    print("-" * 40)
    preprocess_dir = env_dir / "preprocess"
    if check_directory_exists(preprocess_dir, "Preprocess directory"):
        preprocess_files = [
            (preprocess_dir / "main.py", "Main preprocessing script"),
        ]
        for file_path, description in preprocess_files:
            if not check_file_exists(file_path, description):
                all_checks_passed = False
    else:
        all_checks_passed = False
    
    # Check evaluation directory
    print("\n3. Evaluation Directory:")
    print("-" * 40)
    evaluation_dir = env_dir / "evaluation"
    if check_directory_exists(evaluation_dir, "Evaluation directory"):
        evaluation_files = [
            (evaluation_dir / "main.py", "Main evaluation script"),
            (evaluation_dir / "check_local.py", "Local file checker"),
            (evaluation_dir / "check_sheet_comparison.py", "Sheet comparison checker"),
            (evaluation_dir / "check_sheet_direct.py", "Sheet direct checker"),
        ]
        for file_path, description in evaluation_files:
            if not check_file_exists(file_path, description):
                all_checks_passed = False
    else:
        all_checks_passed = False
    
    # Check Python syntax
    print("\n4. Python Syntax Check:")
    print("-" * 40)
    try:
        import py_compile
        syntax_files = [
            env_dir / "nhl_b2b_analysis_s2l.py",
            env_dir / "__init__.py",
        ]
        
        syntax_ok = True
        for file_path in syntax_files:
            try:
                py_compile.compile(str(file_path), doraise=True)
                print(f"✓ Syntax OK: {file_path.name}")
            except py_compile.PyCompileError as e:
                print(f"✗ Syntax Error: {file_path.name}")
                print(f"  Error: {e}")
                syntax_ok = False
                all_checks_passed = False
        
        if syntax_ok:
            print("✓ All Python files have correct syntax")
    except ImportError:
        print("⚠ py_compile not available, skipping syntax check")
    
    # Check class definition
    print("\n5. Class Definition Check:")
    print("-" * 40)
    try:
        # Read the main file and check for class definition
        main_file = env_dir / "nhl_b2b_analysis_s2l.py"
        with open(main_file, 'r') as f:
            content = f.read()
        
        required_elements = [
            ("class NhlB2bAnalysisS2LEnv", "Environment class definition"),
            ("def __init__", "Constructor method"),
            ("def reset", "Reset method"),
            ("def step", "Step method"),
            ("def _get_instructions", "Instructions method"),
            ("TASK_INSTRUCTION", "Task instruction constant"),
        ]
        
        for element, description in required_elements:
            if element in content:
                print(f"✓ Found: {description}")
            else:
                print(f"✗ Missing: {description}")
                all_checks_passed = False
                
    except Exception as e:
        print(f"✗ Error reading main file: {e}")
        all_checks_passed = False
    
    # Summary
    print("\n" + "=" * 80)
    print("Verification Summary")
    print("=" * 80)
    
    if all_checks_passed:
        print("✓ All checks passed! Environment is properly set up.")
        print("\nThe environment should be ready to use.")
        print("\nNote: Full functionality testing requires the gem framework")
        print("      and its dependencies to be properly installed.")
        return 0
    else:
        print("✗ Some checks failed. Please review the errors above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())


