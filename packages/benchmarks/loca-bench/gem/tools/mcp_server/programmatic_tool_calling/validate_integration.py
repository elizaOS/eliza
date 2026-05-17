#!/usr/bin/env python3
"""
Integration Validation Script

This script validates that programmatic_tool_calling is properly integrated
into run_multi_openai_v2.py by checking all integration points.
"""

import sys
from pathlib import Path

# Add gem to path
gem_root = Path(__file__).parent.parent.parent.parent.parent
if str(gem_root) not in sys.path:
    sys.path.insert(0, str(gem_root))


def check_imports():
    """Check that all necessary imports are present."""
    print("=" * 70)
    print("1. Checking Imports")
    print("=" * 70)

    try:
        from gem.tools.mcp_server.programmatic_tool_calling.helper import (
            ProgrammaticToolCallingTool,
            get_programmatic_tool_calling_stdio_config
        )
        print("✓ ProgrammaticToolCallingTool import successful")
        print("✓ get_programmatic_tool_calling_stdio_config import successful")
        return True
    except ImportError as e:
        print(f"✗ Import failed: {e}")
        return False


def check_server_exists():
    """Check that server.py exists and is valid."""
    print("\n" + "=" * 70)
    print("2. Checking Server Implementation")
    print("=" * 70)

    server_path = Path(__file__).parent / "server.py"
    if not server_path.exists():
        print(f"✗ Server file not found: {server_path}")
        return False

    print(f"✓ Server file exists: {server_path}")

    # Check server has required components
    server_content = server_path.read_text()
    required_components = [
        "class ToolCallInterceptor",
        "def programmatic_tool_calling",
        "FastMCP",
        "tool_results_cache",
        "needs_tool_execution"
    ]

    for component in required_components:
        if component in server_content:
            print(f"✓ Server has: {component}")
        else:
            print(f"✗ Server missing: {component}")
            return False

    return True


def check_helper_class():
    """Check that ProgrammaticToolCallingTool is properly implemented."""
    print("\n" + "=" * 70)
    print("3. Checking ProgrammaticToolCallingTool Class")
    print("=" * 70)

    try:
        from gem.tools.mcp_server.programmatic_tool_calling.helper import ProgrammaticToolCallingTool
        from gem.tools.mcp_tool import MCPTool

        # Check inheritance
        if issubclass(ProgrammaticToolCallingTool, MCPTool):
            print("✓ ProgrammaticToolCallingTool inherits from MCPTool")
        else:
            print("✗ ProgrammaticToolCallingTool does not inherit from MCPTool")
            return False

        # Check methods
        required_methods = ["__init__", "set_tools", "execute_tool"]
        for method in required_methods:
            if hasattr(ProgrammaticToolCallingTool, method):
                print(f"✓ Has method: {method}")
            else:
                print(f"✗ Missing method: {method}")
                return False

        return True
    except Exception as e:
        print(f"✗ Error checking class: {e}")
        return False


def check_run_multi_openai_integration():
    """Check that run_multi_openai_v2.py has proper integration."""
    print("\n" + "=" * 70)
    print("4. Checking run_multi_openai_v2.py Integration")
    print("=" * 70)

    run_multi_path = gem_root / "inference" / "run_multi_openai_v2.py"
    if not run_multi_path.exists():
        print(f"✗ run_multi_openai_v2.py not found: {run_multi_path}")
        return False

    print(f"✓ Found run_multi_openai_v2.py: {run_multi_path}")

    content = run_multi_path.read_text()

    # Check imports
    checks = [
        ("Import ProgrammaticToolCallingTool",
         "from gem.tools.mcp_server.programmatic_tool_calling.helper import ProgrammaticToolCallingTool"),
        ("Import get_programmatic_tool_calling_stdio_config",
         "from gem.tools.mcp_server.programmatic_tool_calling.helper import get_programmatic_tool_calling_stdio_config"),
        ("Setup server config",
         'server_type == "programmatic_tool_calling"'),
        ("Conditional tool creation",
         "has_programmatic = any"),
        ("Create ProgrammaticToolCallingTool",
         "tool = ProgrammaticToolCallingTool(mcp_config")
    ]

    all_passed = True
    for check_name, check_string in checks:
        if check_string in content:
            print(f"✓ {check_name}")
        else:
            print(f"✗ {check_name} - not found")
            all_passed = False

    return all_passed


def check_config_helper():
    """Check that config helper works."""
    print("\n" + "=" * 70)
    print("5. Checking Configuration Helper")
    print("=" * 70)

    try:
        from gem.tools.mcp_server.programmatic_tool_calling.helper import (
            get_programmatic_tool_calling_stdio_config
        )

        config = get_programmatic_tool_calling_stdio_config(workspace_path="/tmp/test")

        # Check config structure
        if "programmatic_tool_calling" not in config:
            print("✗ Config missing 'programmatic_tool_calling' key")
            return False

        print("✓ Config has 'programmatic_tool_calling' key")

        server_config = config["programmatic_tool_calling"]

        if "command" not in server_config:
            print("✗ Server config missing 'command' key")
            return False
        print("✓ Server config has 'command' key")

        if "args" not in server_config:
            print("✗ Server config missing 'args' key")
            return False
        print("✓ Server config has 'args' key")

        if "--workspace" not in server_config["args"]:
            print("✗ Server config args missing '--workspace'")
            return False
        print("✓ Server config has '--workspace' argument")

        return True

    except Exception as e:
        print(f"✗ Error checking config helper: {e}")
        import traceback
        traceback.print_exc()
        return False


def check_documentation():
    """Check that documentation exists."""
    print("\n" + "=" * 70)
    print("6. Checking Documentation")
    print("=" * 70)

    doc_files = [
        "README.md",
        "QUICKSTART.md",
        "ARCHITECTURE.md",
        "INTEGRATION.md",
        "USAGE_IN_RUN_MULTI_OPENAI.md",
        "FINAL_SUMMARY.md",
        "VALIDATION_SUMMARY.md"
    ]

    base_path = Path(__file__).parent
    all_found = True

    for doc_file in doc_files:
        doc_path = base_path / doc_file
        if doc_path.exists():
            size_kb = doc_path.stat().st_size / 1024
            print(f"✓ {doc_file} ({size_kb:.1f} KB)")
        else:
            print(f"✗ {doc_file} - not found")
            all_found = False

    return all_found


def check_examples():
    """Check that examples exist."""
    print("\n" + "=" * 70)
    print("7. Checking Examples")
    print("=" * 70)

    example_files = [
        "example_usage.py",
        "example_tool_env_integration.py",
        "example_config.json"
    ]

    base_path = Path(__file__).parent
    all_found = True

    for example_file in example_files:
        example_path = base_path / example_file
        if example_path.exists():
            print(f"✓ {example_file}")
        else:
            print(f"✗ {example_file} - not found")
            all_found = False

    return all_found


def check_tests():
    """Check that tests exist."""
    print("\n" + "=" * 70)
    print("8. Checking Tests")
    print("=" * 70)

    test_path = Path(__file__).parent / "test_programmatic_tool_calling.py"
    if not test_path.exists():
        print(f"✗ Test file not found: {test_path}")
        return False

    print(f"✓ Test file exists: {test_path}")

    # Check test has required test cases
    test_content = test_path.read_text()
    required_tests = [
        "test_basic_execution",
        "test_tool_call_interception",
        "test_multiple_tool_calls",
        "test_error_handling"
    ]

    for test_name in required_tests:
        if test_name in test_content:
            print(f"✓ Has test: {test_name}")
        else:
            print(f"⚠ Missing test: {test_name}")

    return True


def main():
    """Run all validation checks."""
    print("\n" + "=" * 70)
    print("PROGRAMMATIC TOOL CALLING - INTEGRATION VALIDATION")
    print("=" * 70)

    checks = [
        ("Imports", check_imports),
        ("Server Implementation", check_server_exists),
        ("ProgrammaticToolCallingTool Class", check_helper_class),
        ("run_multi_openai_v2.py Integration", check_run_multi_openai_integration),
        ("Configuration Helper", check_config_helper),
        ("Documentation", check_documentation),
        ("Examples", check_examples),
        ("Tests", check_tests)
    ]

    results = {}
    for check_name, check_func in checks:
        results[check_name] = check_func()

    # Summary
    print("\n" + "=" * 70)
    print("VALIDATION SUMMARY")
    print("=" * 70)

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    for check_name, result in results.items():
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"{status}: {check_name}")

    print("\n" + "=" * 70)
    print(f"Overall: {passed}/{total} checks passed")

    if passed == total:
        print("✅ ALL CHECKS PASSED - Integration is complete!")
        print("=" * 70)
        return 0
    else:
        print("❌ Some checks failed - please review errors above")
        print("=" * 70)
        return 1


if __name__ == "__main__":
    sys.exit(main())
