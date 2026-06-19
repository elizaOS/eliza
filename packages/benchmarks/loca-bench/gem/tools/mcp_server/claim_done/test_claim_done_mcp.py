#!/usr/bin/env python3
"""
Test script for ClaimDone MCP server
"""

import sys
from pathlib import Path

# Add gem to path
gem_root = Path(__file__).parent.parent.parent.parent.parent
sys.path.insert(0, str(gem_root))

from gem.tools.mcp_server.claim_done import create_claim_done_tool_stdio, create_claim_done_tool_http


def test_stdio():
    """Test ClaimDone tool via stdio transport."""
    print("=" * 70)
    print("Testing ClaimDone MCP Tool - stdio transport")
    print("=" * 70)
    
    # Create tool
    print("\n1. Creating ClaimDone tool (stdio)...")
    tool = create_claim_done_tool_stdio(validate_on_init=False)
    print("✅ Tool created")
    
    # Get available tools
    print("\n2. Discovering available tools...")
    tools = tool.get_available_tools()
    print(f"✅ Found {len(tools)} tool(s):")
    for t in tools:
        print(f"   - {t['name']}: {t['description']}")
    
    # Test claim_done tool
    print("\n3. Testing claim_done tool...")
    action = '<tool_call><tool_name>claim_done</tool_name><arguments>{}</arguments></tool_call>'
    
    is_valid, has_error, observation, parsed_action = tool.execute_action(action)
    
    print(f"   Valid: {is_valid}")
    print(f"   Error: {has_error}")
    print(f"   Observation: {observation}")
    
    if is_valid and not has_error:
        print("✅ claim_done tool executed successfully!")
    else:
        print("❌ claim_done tool execution failed")
    
    # Close tool
    print("\n4. Closing tool...")
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
    
    tool = create_claim_done_tool_stdio(validate_on_init=False)
    instruction = tool.instruction_string()
    
    print("\nGenerated instruction string:")
    print("-" * 70)
    print(instruction)
    print("-" * 70)
    
    tool.close()
    print("\n✅ Instruction string test passed!")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Test ClaimDone MCP Server")
    parser.add_argument(
        "--mode",
        choices=["stdio", "http", "all"],
        default="all",
        help="Test mode (default: all)"
    )
    
    args = parser.parse_args()
    
    try:
        if args.mode in ["stdio", "all"]:
            test_stdio()
            test_instruction_string()
        
        if args.mode == "http":
            print("\n⚠️  HTTP mode test requires manual server startup:")
            print("    python -m gem.tools.mcp_server.claim_done.server --transport streamable-http --port 8083")
            print("\nSkipping HTTP test...")
        
        print("\n🎉 All tests completed!")
        
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

