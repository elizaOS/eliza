#!/usr/bin/env python3
"""
Test verification script for python-plugin-starter.

This script verifies that:
1. All test files have valid syntax
2. Plugin is properly configured with tests
3. Test structure matches expected format
"""

import ast
import sys
from pathlib import Path

def check_syntax(filepath: Path) -> tuple[bool, str]:
    """Check if a Python file has valid syntax."""
    try:
        with open(filepath, 'r') as f:
            ast.parse(f.read())
        return True, "✓"
    except SyntaxError as e:
        return False, f"✗ Syntax error: {e}"

def main():
    """Run verification checks."""
    base_dir = Path(__file__).parent
    errors = []
    
    print("Verifying Python Plugin Starter Tests\n")
    print("=" * 50)
    
    # Check plugin.py
    plugin_file = base_dir / "elizaos_plugin_starter" / "plugin.py"
    print(f"\n1. Checking {plugin_file.name}...")
    valid, msg = check_syntax(plugin_file)
    print(f"   {msg}")
    if not valid:
        errors.append(f"{plugin_file}: {msg}")
    
    # Check tests.py (E2E tests)
    tests_file = base_dir / "elizaos_plugin_starter" / "tests.py"
    print(f"\n2. Checking {tests_file.name} (E2E tests)...")
    valid, msg = check_syntax(tests_file)
    print(f"   {msg}")
    if not valid:
        errors.append(f"{tests_file}: {msg}")
    
    # Check test_plugin.py (unit tests)
    unit_test_file = base_dir / "tests" / "test_plugin.py"
    print(f"\n3. Checking {unit_test_file.name} (unit tests)...")
    valid, msg = check_syntax(unit_test_file)
    print(f"   {msg}")
    if not valid:
        errors.append(f"{unit_test_file}: {msg}")
    
    # Check plugin configuration
    print(f"\n4. Checking plugin configuration...")
    with open(plugin_file, 'r') as f:
        content = f.read()
        if 'tests=[' in content or 'tests = [' in content:
            if 'python_plugin_starter_test_suite' in content:
                print("   ✓ Plugin has tests property with test suite")
            else:
                print("   ⚠ Plugin has tests property but test suite import may be missing")
                errors.append("Test suite not properly imported in plugin")
        else:
            print("   ✗ Plugin missing tests property")
            errors.append("Plugin missing tests property")
    
    # Count tests
    print(f"\n5. Counting tests...")
    with open(tests_file, 'r') as f:
        content = f.read()
        e2e_tests = content.count('async def') - 1  # Subtract create_test_suite
        test_cases = content.count('TestCase(')
        print(f"   ✓ Found {e2e_tests} E2E test functions")
        print(f"   ✓ Found {test_cases} TestCase definitions")
    
    with open(unit_test_file, 'r') as f:
        content = f.read()
        unit_tests = content.count('def test_')
        print(f"   ✓ Found {unit_tests} pytest test methods")
    
    # Summary
    print("\n" + "=" * 50)
    if errors:
        print("\n✗ Verification failed with errors:")
        for error in errors:
            print(f"  - {error}")
        return 1
    else:
        print("\n✓ All checks passed! Tests are properly structured.")
        print("\nTo run tests:")
        print("  1. Install dependencies: pip install -e '.[dev]'")
        print("  2. Run unit tests: pytest tests/ -v")
        print("  3. Run E2E tests: elizaos test --type e2e")
        return 0

if __name__ == "__main__":
    sys.exit(main())


