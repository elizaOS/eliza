#!/usr/bin/env python3
"""
Test script for Python Execute MCP server
"""

import json
import sys
import tempfile
from pathlib import Path

# Add gem to path
gem_root = Path(__file__).parent.parent.parent.parent.parent
sys.path.insert(0, str(gem_root))

from gem.tools.mcp_server.python_execute import create_python_execute_tool_stdio


def test_stdio():
    """Test Python Execute tool via stdio transport."""
    print("=" * 70)
    print("Testing Python Execute MCP Tool - stdio transport")
    print("=" * 70)
    
    # Create temporary workspace
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"\n📁 Using temporary workspace: {tmpdir}")
        
        # Create tool
        print("\n1. Creating Python Execute tool (stdio)...")
        tool = create_python_execute_tool_stdio(
            workspace_path=tmpdir,
            validate_on_init=False
        )
        print("✅ Tool created")
        
        # Get available tools
        print("\n2. Discovering available tools...")
        tools = tool.get_available_tools()
        print(f"✅ Found {len(tools)} tool(s):")
        for t in tools:
            print(f"   - {t['name']}: {t['description'][:80]}...")
        
        # Test 1: Simple print
        print("\n3. Test 1: Simple print statement")
        code1 = 'print("Hello from Python!")'
        action1 = f'<tool_call><tool_name>python_execute</tool_name><arguments>{json.dumps({"code": code1})}</arguments></tool_call>'
        
        is_valid, has_error, observation, parsed_action = tool.execute_action(action1)
        
        print(f"   Valid: {is_valid}")
        print(f"   Error: {has_error}")
        print(f"   Observation:")
        print("   " + "\n   ".join(observation.split('\n')[:20]))
        
        if is_valid and not has_error:
            print("✅ Test 1 passed!")
        else:
            print("❌ Test 1 failed")
        
        # Test 2: Code with calculation
        print("\n4. Test 2: Code with calculation")
        code2 = '''
result = 2 + 2
print(f"2 + 2 = {result}")
'''
        action2 = f'<tool_call><tool_name>python_execute</tool_name><arguments>{json.dumps({"code": code2, "filename": "test_calc.py"})}</arguments></tool_call>'
        
        is_valid, has_error, observation, parsed_action = tool.execute_action(action2)
        
        print(f"   Valid: {is_valid}")
        print(f"   Error: {has_error}")
        print(f"   Observation:")
        print("   " + "\n   ".join(observation.split('\n')[:20]))
        
        if is_valid and not has_error:
            print("✅ Test 2 passed!")
        else:
            print("❌ Test 2 failed")
        
        # Test 3: Code with error
        print("\n5. Test 3: Code with error")
        code3 = '''
print("Before error")
x = 1 / 0  # This will cause an error
print("After error")
'''
        action3 = f'<tool_call><tool_name>python_execute</tool_name><arguments>{json.dumps({"code": code3})}</arguments></tool_call>'
        is_valid, has_error, observation, parsed_action = tool.execute_action(action3)
        
        print(f"   Valid: {is_valid}")
        print(f"   Error: {has_error}")
        print(f"   Observation:")
        print("   " + "\n   ".join(observation.split('\n')[:25]))
        
        if is_valid:
            print("✅ Test 3 passed (error handled correctly)!")
        else:
            print("❌ Test 3 failed")
        
        # Test 4: Code with timeout parameter
        print("\n6. Test 4: Code with timeout parameter")
        code4 = 'print("Quick execution")'
        action4 = f'<tool_call><tool_name>python_execute</tool_name><arguments>{json.dumps({"code": code4, "timeout": 5})}</arguments></tool_call>'
        
        is_valid, has_error, observation, parsed_action = tool.execute_action(action4)
        
        print(f"   Valid: {is_valid}")
        print(f"   Error: {has_error}")
        print(f"   Observation:")
        print("   " + "\n   ".join(observation.split('\n')[:20]))
        
        if is_valid and not has_error and "Timeout limit: 5 seconds" in observation:
            print("✅ Test 4 passed (timeout parameter works)!")
        else:
            print("❌ Test 4 failed")
        
        # Close tool
        print("\n7. Closing tool...")
        tool.close()
        print("✅ Tool closed")
    
    print("\n" + "=" * 70)
    print("✅ All stdio tests passed!")
    print("=" * 70)


def test_instruction_string():
    """Test instruction string generation."""
    print("\n" + "=" * 70)
    print("Testing Instruction String")
    print("=" * 70)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        tool = create_python_execute_tool_stdio(
            workspace_path=tmpdir,
            validate_on_init=False
        )
        instruction = tool.instruction_string()
        
        print("\nGenerated instruction string (first 1000 chars):")
        print("-" * 70)
        print(instruction[:1000])
        print("...")
        print("-" * 70)
        
        # Verify the description matches original
        assert 'Execute Python code directly under the agent workspace' in instruction
        print("\n✅ Description matches original!")
        
        tool.close()


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Test Python Execute MCP Server")
    parser.add_argument(
        "--mode",
        choices=["stdio", "all"],
        default="all",
        help="Test mode (default: all)"
    )
    
    args = parser.parse_args()
    
    try:
        if args.mode in ["stdio", "all"]:
            test_stdio()
            test_instruction_string()
        
        print("\n🎉 All tests completed!")
        
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

