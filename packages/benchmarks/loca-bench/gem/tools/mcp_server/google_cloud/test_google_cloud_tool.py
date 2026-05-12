"""
Test script for Google Cloud MCP Tool.

This script tests the basic functionality of the Google Cloud MCP Tool
including tool creation, listing tools, and executing basic operations.

Usage:
    python test_google_cloud_tool.py
"""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.google_cloud import (
    create_google_cloud_tool_stdio,
    get_google_cloud_stdio_config,
)


def test_get_config():
    """Test get_google_cloud_stdio_config function."""
    print("\n" + "=" * 80)
    print("Test 1: Get Google Cloud stdio config")
    print("=" * 80)
    
    try:
        config = get_google_cloud_stdio_config(
            data_dir="./test_google_cloud_data"
        )
        
        print(f"✓ Config retrieved successfully")
        print(f"  Server name: {list(config.keys())[0]}")
        
        server_config = config[list(config.keys())[0]]
        print(f"  Command: {server_config['command']}")
        print(f"  Args: {server_config['args'][:3]}...")  # Show first 3 args
        print(f"  Env vars: {list(server_config['env'].keys())}")
        
        return True
    except Exception as e:
        print(f"✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_create_tool_stdio():
    """Test creating Google Cloud tool in stdio mode."""
    print("\n" + "=" * 80)
    print("Test 2: Create Google Cloud tool (stdio mode)")
    print("=" * 80)
    
    try:
        tool = create_google_cloud_tool_stdio(
            data_dir="./test_google_cloud_data",
            validate_on_init=False
        )
        
        print(f"✓ Tool created successfully")
        print(f"  Tool type: {type(tool).__name__}")
        
        return tool
    except Exception as e:
        print(f"✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return None


def test_list_tools(tool):
    """Test listing available tools."""
    print("\n" + "=" * 80)
    print("Test 3: List available tools")
    print("=" * 80)
    
    try:
        tools = tool.get_available_tools()
        
        print(f"✓ Found {len(tools)} tools")
        
        # Group by category
        bigquery_tools = [t for t in tools if t.startswith('bigquery_')]
        storage_tools = [t for t in tools if t.startswith('storage_')]
        compute_tools = [t for t in tools if t.startswith('compute_')]
        iam_tools = [t for t in tools if t.startswith('iam_')]
        
        print(f"\n  BigQuery tools: {len(bigquery_tools)}")
        if bigquery_tools:
            print(f"    Examples: {', '.join(bigquery_tools[:3])}")
        
        print(f"\n  Cloud Storage tools: {len(storage_tools)}")
        if storage_tools:
            print(f"    Examples: {', '.join(storage_tools[:3])}")
        
        print(f"\n  Compute Engine tools: {len(compute_tools)}")
        if compute_tools:
            print(f"    Examples: {', '.join(compute_tools[:3])}")
        
        print(f"\n  IAM tools: {len(iam_tools)}")
        if iam_tools:
            print(f"    Examples: {', '.join(iam_tools[:3])}")
        
        return len(tools) > 0
    except Exception as e:
        print(f"✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_bigquery_operations(tool):
    """Test BigQuery operations."""
    print("\n" + "=" * 80)
    print("Test 4: BigQuery operations")
    print("=" * 80)
    
    # Test 1: List datasets
    print("\n  4.1. List datasets...")
    try:
        action = '<tool_call><tool_name>bigquery_list_datasets</tool_name></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print(f"  ✓ Success: {obs[:100]}...")
        else:
            print(f"  ✗ Failed: {obs}")
            return False
    except Exception as e:
        print(f"  ✗ Exception: {e}")
        return False
    
    return True


def test_storage_operations(tool):
    """Test Cloud Storage operations."""
    print("\n" + "=" * 80)
    print("Test 5: Cloud Storage operations")
    print("=" * 80)
    
    # Test 1: List buckets
    print("\n  5.1. List buckets...")
    try:
        action = '<tool_call><tool_name>storage_list_buckets</tool_name></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print(f"  ✓ Success: {obs[:100]}...")
        else:
            print(f"  ✗ Failed: {obs}")
            return False
    except Exception as e:
        print(f"  ✗ Exception: {e}")
        return False
    
    return True


def test_compute_operations(tool):
    """Test Compute Engine operations."""
    print("\n" + "=" * 80)
    print("Test 6: Compute Engine operations")
    print("=" * 80)
    
    # Test 1: List instances
    print("\n  6.1. List instances...")
    try:
        action = '<tool_call><tool_name>compute_list_instances</tool_name><parameters><zone>us-central1-a</zone></parameters></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print(f"  ✓ Success: {obs[:100]}...")
        else:
            print(f"  ✗ Failed: {obs}")
            return False
    except Exception as e:
        print(f"  ✗ Exception: {e}")
        return False
    
    return True


def test_iam_operations(tool):
    """Test IAM operations."""
    print("\n" + "=" * 80)
    print("Test 7: IAM operations")
    print("=" * 80)
    
    # Test 1: List service accounts
    print("\n  7.1. List service accounts...")
    try:
        action = '<tool_call><tool_name>iam_list_service_accounts</tool_name></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print(f"  ✓ Success: {obs[:100]}...")
        else:
            print(f"  ✗ Failed: {obs}")
            return False
    except Exception as e:
        print(f"  ✗ Exception: {e}")
        return False
    
    return True


def main():
    """Run all tests."""
    print("\n" + "=" * 80)
    print("Google Cloud MCP Tool - Test Suite")
    print("=" * 80)
    
    results = []
    
    # Test 1: Get config
    results.append(("Get Config", test_get_config()))
    
    # Test 2: Create tool
    tool = test_create_tool_stdio()
    if tool is None:
        print("\n✗ Cannot continue tests - tool creation failed")
        return
    results.append(("Create Tool", True))
    
    # Test 3: List tools
    results.append(("List Tools", test_list_tools(tool)))
    
    # Test 4-7: Operations
    results.append(("BigQuery Operations", test_bigquery_operations(tool)))
    results.append(("Storage Operations", test_storage_operations(tool)))
    results.append(("Compute Operations", test_compute_operations(tool)))
    results.append(("IAM Operations", test_iam_operations(tool)))
    
    # Print summary
    print("\n" + "=" * 80)
    print("Test Summary")
    print("=" * 80)
    
    for test_name, passed in results:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"  {status}: {test_name}")
    
    total = len(results)
    passed = sum(1 for _, p in results if p)
    
    print(f"\n  Total: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 All tests passed!")
    else:
        print(f"\n⚠️  {total - passed} test(s) failed")
    
    print("=" * 80)


if __name__ == "__main__":
    main()

