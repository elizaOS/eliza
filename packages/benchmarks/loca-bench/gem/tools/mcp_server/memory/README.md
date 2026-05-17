# Memory MCP Server

Knowledge graph-based memory system for storing and retrieving information across conversations.

## Overview

This module provides easy access to the `@modelcontextprotocol/server-memory` MCP server, which implements a knowledge graph to store entities, their properties, and relationships.

The memory server is run via `npx` and communicates through stdio transport, making it easy to use without any server setup.

## Prerequisites

- Node.js and npm/npx installed
- Internet connection (for first-time npx package download)

## Usage

### Method 1: Using the Helper Function (Recommended)

```python
from gem.tools.mcp_server.memory import create_memory_tool

# Create tool with default settings
tool = create_memory_tool()

# Or specify custom memory file location
tool = create_memory_tool(
    memory_file_path="/path/to/memory.json"
)

# Get available tools
tools = tool.get_available_tools()
for t in tools:
    print(f"{t['name']}: {t['description']}")

# Use in your application
instruction = tool.instruction_string()
print(instruction)
```

### Method 2: Using MCPTool Directly

```python
from gem.tools.mcp_tool import MCPTool

# Create configuration
config = {
    "mcpServers": {
        "memory": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory"],
            "env": {
                "MEMORY_FILE_PATH": "./memory.json"
            }
        }
    }
}

# Create tool
tool = MCPTool(config)
```

### Method 3: From Config File

```python
from gem.tools.mcp_server.memory import create_memory_tool_from_config

# Uses the default config.json in this directory
tool = create_memory_tool_from_config()

# Or specify a custom config file
tool = create_memory_tool_from_config(
    config_path="/path/to/custom_config.json"
)
```

## Available Tools

The Memory server typically provides the following tools:

### Entity Management
- **create_entities**: Store new information as entities with observations
  - Creates nodes in the knowledge graph
  - Each entity can have multiple observations (facts about the entity)

- **delete_entities**: Remove entities from the graph
  - Removes all associated observations and relations

- **open_nodes**: Retrieve detailed information about specific entities
  - Returns entity name, type, and all observations

- **search_nodes**: Search for entities by name or content
  - Full-text search across entity names and observations

### Relationship Management
- **create_relations**: Define relationships between entities
  - Creates edges between nodes with labeled relationship types

- **delete_relations**: Remove specific relationships
  - Keeps the entities but removes the connection

- **delete_observations**: Remove specific observations from entities
  - Fine-grained control over entity information

### Graph Querying
- **read_graph**: Query and explore the knowledge graph
  - Can retrieve the entire graph or filter by specific criteria

## Example: Complete Workflow

```python
from gem.tools.mcp_server.memory import create_memory_tool

# Initialize the tool
tool = create_memory_tool(memory_file_path="./my_memory.json")

# Example action: Create entities
action1 = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "John Doe",
      "entityType": "person",
      "observations": [
        "John is a software engineer",
        "John works at TechCorp",
        "John loves Python programming"
      ]
    }
  ]
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action1)
print(f"Result: {observation}")

# Example action: Create relationships
action2 = '''
<tool_call>
<tool_name>create_relations</tool_name>
<arguments>
{
  "relations": [
    {
      "from": "John Doe",
      "to": "TechCorp",
      "relationType": "works_at"
    }
  ]
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action2)
print(f"Result: {observation}")

# Example action: Search nodes
action3 = '''
<tool_call>
<tool_name>search_nodes</tool_name>
<arguments>
{
  "query": "Python"
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action3)
print(f"Search results: {observation}")

# Example action: Read entire graph
action4 = '''
<tool_call>
<tool_name>read_graph</tool_name>
<arguments>
{}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action4)
print(f"Graph: {observation}")
```

## Configuration

The memory server uses a JSON file to persist the knowledge graph. The file location is specified via the `MEMORY_FILE_PATH` environment variable.

Default configuration (`config.json`):
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "./memory_data/memory.json"
      }
    }
  }
}
```

## Memory File Structure

The memory file is a JSON file with the following structure:
```json
{
  "entities": [
    {
      "name": "entity_name",
      "entityType": "type",
      "observations": ["observation1", "observation2"]
    }
  ],
  "relations": [
    {
      "from": "entity1",
      "to": "entity2",
      "relationType": "relation_type"
    }
  ]
}
```

## Integration with GEM

The Memory tool can be used with GEM environments:

```python
import gem
from gem.tools.mcp_server.memory import create_memory_tool
from gem.tools.tool_env_wrapper import ToolEnvWrapper

# Create environment
env = gem.make("math:GSM8K")

# Create memory tool
memory_tool = create_memory_tool()

# Wrap environment with tool
wrapped_env = ToolEnvWrapper(env, tools=[memory_tool])

# Use the environment
obs, info = wrapped_env.reset()
```

## Troubleshooting

### "npx not found"
Make sure Node.js and npm are installed:
```bash
node --version
npm --version
```

### Package download issues
The first time you run the tool, npx will download `@modelcontextprotocol/server-memory`.
Ensure you have internet connectivity.

### Memory file permissions
Make sure the directory where the memory file is stored is writable:
```bash
mkdir -p ./memory_data
chmod 755 ./memory_data
```

## References

- [MCP Memory Server Documentation](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [GEM Framework Documentation](https://github.com/axon-rl/gem)
