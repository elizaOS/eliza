#!/usr/bin/env python3
"""Test script for Memory MCP server integration."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.memory import create_memory_tool


def test_basic_connection():
    """Test basic connection and tool discovery."""
    print("=" * 60)
    print("Testing Memory MCP Server Connection")
    print("=" * 60)
    
    try:
        # Create tool with a test memory file
        tool = create_memory_tool(
            memory_file_path="./test_memory.json",
            validate_on_init=True
        )
        
        print("✓ Successfully created Memory tool")
        
        # Get available tools
        tools = tool.get_available_tools()
        print(f"\n✓ Found {len(tools)} available tools:")
        for t in tools:
            print(f"  - {t['name']}: {t['description']}")
        
        return tool
        
    except Exception as e:
        print(f"\n✗ Failed to create Memory tool: {e}")
        return None


def test_create_entities(tool):
    """Test creating entities."""
    print("\n" + "=" * 60)
    print("Testing Entity Creation")
    print("=" * 60)
    
    action = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Alice",
      "entityType": "person",
      "observations": [
        "Alice is a data scientist",
        "Alice works on machine learning",
        "Alice loves Python"
      ]
    },
    {
      "name": "TechCorp",
      "entityType": "company",
      "observations": [
        "TechCorp is a software company",
        "TechCorp specializes in AI"
      ]
    }
  ]
}
</arguments>
</tool_call>
'''
    
    is_valid, has_error, observation, parsed = tool.execute_action(action)
    
    if is_valid and not has_error:
        print("✓ Successfully created entities")
        print(f"Result: {observation}")
    else:
        print(f"✗ Failed to create entities: {observation}")
    
    return is_valid and not has_error


def test_create_relations(tool):
    """Test creating relationships."""
    print("\n" + "=" * 60)
    print("Testing Relationship Creation")
    print("=" * 60)
    
    action = '''
<tool_call>
<tool_name>create_relations</tool_name>
<arguments>
{
  "relations": [
    {
      "from": "Alice",
      "to": "TechCorp",
      "relationType": "works_at"
    }
  ]
}
</arguments>
</tool_call>
'''
    
    is_valid, has_error, observation, parsed = tool.execute_action(action)
    
    if is_valid and not has_error:
        print("✓ Successfully created relationships")
        print(f"Result: {observation}")
    else:
        print(f"✗ Failed to create relationships: {observation}")
    
    return is_valid and not has_error


def test_search_nodes(tool):
    """Test searching nodes."""
    print("\n" + "=" * 60)
    print("Testing Node Search")
    print("=" * 60)
    
    action = '''
<tool_call>
<tool_name>search_nodes</tool_name>
<arguments>
{
  "query": "Python"
}
</arguments>
</tool_call>
'''
    
    is_valid, has_error, observation, parsed = tool.execute_action(action)
    
    if is_valid and not has_error:
        print("✓ Successfully searched nodes")
        print(f"Results: {observation}")
    else:
        print(f"✗ Failed to search nodes: {observation}")
    
    return is_valid and not has_error


def test_read_graph(tool):
    """Test reading the entire graph."""
    print("\n" + "=" * 60)
    print("Testing Graph Reading")
    print("=" * 60)
    
    action = '''
<tool_call>
<tool_name>read_graph</tool_name>
<arguments>
{}
</arguments>
</tool_call>
'''
    
    is_valid, has_error, observation, parsed = tool.execute_action(action)
    
    if is_valid and not has_error:
        print("✓ Successfully read graph")
        print(f"Graph: {observation}")
    else:
        print(f"✗ Failed to read graph: {observation}")
    
    return is_valid and not has_error


def main():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("Memory MCP Server Test Suite")
    print("=" * 60)
    print("\nNote: This will use npx to run @modelcontextprotocol/server-memory")
    print("The first run may take a moment to download the package.\n")
    
    # Test connection
    tool = test_basic_connection()
    if not tool:
        print("\n✗ Connection test failed. Exiting.")
        return 1
    
    # Test entity creation
    if not test_create_entities(tool):
        print("\n⚠ Entity creation test failed, but continuing...")
    
    # Test relationship creation
    if not test_create_relations(tool):
        print("\n⚠ Relationship creation test failed, but continuing...")
    
    # Test search
    if not test_search_nodes(tool):
        print("\n⚠ Search test failed, but continuing...")
    
    # Test graph reading
    if not test_read_graph(tool):
        print("\n⚠ Graph reading test failed.")
    
    print("\n" + "=" * 60)
    print("Test Suite Complete")
    print("=" * 60)
    
    # Cleanup
    tool.close()
    
    # Clean up test memory file
    test_memory_path = Path("./test_memory.json")
    if test_memory_path.exists():
        test_memory_path.unlink()
        print("\n✓ Cleaned up test memory file")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
