#!/usr/bin/env python3
"""Example usage of Memory MCP server for building a knowledge graph."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.memory import create_memory_tool


def main():
    """Demonstrate Memory server capabilities with a real-world scenario."""
    print("=" * 70)
    print("Memory MCP Server - Knowledge Graph Example")
    print("=" * 70)
    print("\nScenario: Building a knowledge graph about a software team\n")
    
    # Create tool
    tool = create_memory_tool(
        memory_file_path="./example_memory.json",
        validate_on_init=True
    )
    
    print("✓ Memory tool initialized\n")
    
    # Step 1: Create team members
    print("Step 1: Creating team member entities...")
    print("-" * 70)
    
    create_members = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Alice Chen",
      "entityType": "person",
      "observations": [
        "Alice is a senior software engineer",
        "Alice specializes in machine learning",
        "Alice leads the ML team",
        "Alice has 8 years of experience"
      ]
    },
    {
      "name": "Bob Smith",
      "entityType": "person",
      "observations": [
        "Bob is a backend developer",
        "Bob works on the API infrastructure",
        "Bob is proficient in Python and Go"
      ]
    },
    {
      "name": "Carol Wang",
      "entityType": "person",
      "observations": [
        "Carol is a data scientist",
        "Carol analyzes user behavior",
        "Carol has a PhD in Statistics"
      ]
    }
  ]
}
</arguments>
</tool_call>
'''
    
    _, _, obs, _ = tool.execute_action(create_members)
    print(obs)
    
    # Step 2: Create projects and technologies
    print("\nStep 2: Creating project and technology entities...")
    print("-" * 70)
    
    create_projects = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Recommendation Engine",
      "entityType": "project",
      "observations": [
        "ML-based product recommendation system",
        "Uses collaborative filtering",
        "Deployed in production since Q1 2024"
      ]
    },
    {
      "name": "User Analytics Platform",
      "entityType": "project",
      "observations": [
        "Real-time user behavior tracking",
        "Provides insights dashboard",
        "Processes 1M events per day"
      ]
    },
    {
      "name": "Python",
      "entityType": "technology",
      "observations": [
        "Primary programming language",
        "Used for ML and backend services"
      ]
    },
    {
      "name": "TensorFlow",
      "entityType": "technology",
      "observations": [
        "ML framework used for deep learning models",
        "Version 2.15 in production"
      ]
    }
  ]
}
</arguments>
</tool_call>
'''
    
    _, _, obs, _ = tool.execute_action(create_projects)
    print(obs)
    
    # Step 3: Create relationships
    print("\nStep 3: Establishing relationships...")
    print("-" * 70)
    
    create_relations = '''
<tool_call>
<tool_name>create_relations</tool_name>
<arguments>
{
  "relations": [
    {
      "from": "Alice Chen",
      "to": "Recommendation Engine",
      "relationType": "leads"
    },
    {
      "from": "Bob Smith",
      "to": "Recommendation Engine",
      "relationType": "contributes_to"
    },
    {
      "from": "Carol Wang",
      "to": "User Analytics Platform",
      "relationType": "works_on"
    },
    {
      "from": "Alice Chen",
      "to": "Python",
      "relationType": "uses"
    },
    {
      "from": "Alice Chen",
      "to": "TensorFlow",
      "relationType": "uses"
    },
    {
      "from": "Recommendation Engine",
      "to": "TensorFlow",
      "relationType": "built_with"
    },
    {
      "from": "Recommendation Engine",
      "to": "Python",
      "relationType": "built_with"
    }
  ]
}
</arguments>
</tool_call>
'''
    
    _, _, obs, _ = tool.execute_action(create_relations)
    print(obs)
    
    # Step 4: Query the knowledge graph
    print("\nStep 4: Querying the knowledge graph...")
    print("-" * 70)
    
    # Search for machine learning related entities
    print("\nSearching for 'machine learning':")
    search_ml = '''
<tool_call>
<tool_name>search_nodes</tool_name>
<arguments>
{"query": "machine learning"}
</arguments>
</tool_call>
'''
    
    _, _, obs, _ = tool.execute_action(search_ml)
    print(obs)
    
    # Get detailed info about Alice
    print("\nGetting detailed information about Alice Chen:")
    open_alice = '''
<tool_call>
<tool_name>open_nodes</tool_name>
<arguments>
{"names": ["Alice Chen"]}
</arguments>
</tool_call>
'''
    
    _, _, obs, _ = tool.execute_action(open_alice)
    print(obs)
    
    # Read the entire graph
    print("\nReading the entire knowledge graph:")
    read_graph = '''
<tool_call>
<tool_name>read_graph</tool_name>
<arguments>
{}
</arguments>
</tool_call>
'''
    
    _, _, obs, _ = tool.execute_action(read_graph)
    print(obs)
    
    # Step 5: Update knowledge
    print("\nStep 5: Updating knowledge (adding new observation)...")
    print("-" * 70)
    
    add_observation = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Alice Chen",
      "entityType": "person",
      "observations": [
        "Alice received the 2024 Innovation Award"
      ]
    }
  ]
}
</arguments>
</tool_call>
'''
    
    _, _, obs, _ = tool.execute_action(add_observation)
    print(obs)
    
    # Verify the update
    print("\nVerifying the update:")
    _, _, obs, _ = tool.execute_action(open_alice)
    print(obs)
    
    # Summary
    print("\n" + "=" * 70)
    print("Example Complete!")
    print("=" * 70)
    print("\nThe knowledge graph now contains:")
    print("  - 7 entities (3 people, 2 projects, 2 technologies)")
    print("  - 7 relationships")
    print("  - Multiple observations per entity")
    print("\nMemory file location: ./example_memory.json")
    print("You can inspect this file to see the persisted knowledge graph.")
    
    # Cleanup
    tool.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\nError: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
