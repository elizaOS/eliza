#!/usr/bin/env python3
"""Verify that all MCP server modules can be imported correctly."""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))


def test_memory_import():
    """Test memory server imports."""
    print("Testing memory server imports...")
    try:
        from gem.tools.mcp_server.memory import create_memory_tool
        print("  ✓ memory.create_memory_tool")
        
        from gem.tools.mcp_server.memory import create_memory_tool_from_config
        print("  ✓ memory.create_memory_tool_from_config")
        
        return True
    except Exception as e:
        print(f"  ✗ Failed: {e}")
        return False


def test_mcp_tool_import():
    """Test MCPTool import."""
    print("\nTesting MCPTool import...")
    try:
        from gem.tools.mcp_tool import MCPTool
        print("  ✓ MCPTool")
        return True
    except Exception as e:
        print(f"  ✗ Failed: {e}")
        return False


def main():
    """Run all import tests."""
    print("=" * 60)
    print("MCP Server Import Verification")
    print("=" * 60)
    print()
    
    results = []
    
    # Test imports
    results.append(("MCPTool", test_mcp_tool_import()))
    results.append(("Memory Server", test_memory_import()))
    
    # Summary
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    
    passed = sum(1 for _, r in results if r)
    total = len(results)
    
    for name, result in results:
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"{status}: {name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n✓ All imports successful!")
        return 0
    else:
        print(f"\n✗ {total - passed} import(s) failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
