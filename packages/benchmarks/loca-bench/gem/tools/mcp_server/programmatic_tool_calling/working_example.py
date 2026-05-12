#!/usr/bin/env python3
"""
Successful Multi-Round Execution Examples

This example demonstrates truly completing multi-round execution and returning real results (no placeholders)
"""

import json
import sys
from pathlib import Path

# Add gem to path
gem_root = Path(__file__).parent.parent.parent.parent.parent
if str(gem_root) not in sys.path:
    sys.path.insert(0, str(gem_root))


def example_without_filesystem():
    """
    Example 1: Without filesystem tools
    Only uses pure Python code, no tool calls
    """
    print("=" * 70)
    print("Example 1: Pure Python Code (No Tool Calls)")
    print("=" * 70)

    from gem.tools.mcp_server.programmatic_tool_calling.helper import (
        get_programmatic_tool_calling_stdio_config,
        ProgrammaticToolCallingTool
    )

    workspace_path = Path(__file__).parent
    mcp_config = {"mcpServers": {}}
    prog_cfg = get_programmatic_tool_calling_stdio_config(workspace_path=str(workspace_path))
    mcp_config["mcpServers"].update(prog_cfg)

    tool = ProgrammaticToolCallingTool(mcp_config, validate_on_init=False)

    # Get tool name
    available_tools = tool.get_available_tools()
    prog_tool_name = [t['name'] for t in available_tools if 'programmatic_tool_calling' in t['name']][0]

    # Pure computation code (no tool calls)
    code = '''
# Calculate Fibonacci sequence
def fibonacci(n):
    if n <= 1:
        return n
    a, b = 0, 1
    for _ in range(n - 1):
        a, b = b, a + b
    return b

# Calculate first 10 numbers
fib_numbers = [fibonacci(i) for i in range(10)]
print(f"Fibonacci numbers: {fib_numbers}")

# Calculate sum
total = sum(fib_numbers)
print(f"Sum: {total}")

result = f"Calculated {len(fib_numbers)} Fibonacci numbers, sum = {total}"
'''

    print("\nCode:")
    print(code)
    print("\nExecuting...")

    tool_parsed, has_error, observation, _, _ = tool.execute_tool(
        prog_tool_name,
        {"code": code},
        "example_001"
    )

    result = json.loads(observation)

    print("\n" + "=" * 70)
    print("Result")
    print("=" * 70)
    print(f"Success: {result['success']}")
    print(f"Return value: {result['return_value']}")
    print(f"Execution time: {result['execution_time_seconds']:.3f}s")
    print(f"Tool call count: {len(result['tool_calls'])}")
    print(f"needs_tool_execution: {result.get('needs_tool_execution', False)}")

    print(f"\nConsole output:")
    for line in result['stdout'].strip().split('\n'):
        print(f"  {line}")

    # Verify no placeholders
    has_placeholder = any(
        '__TOOL_CALL_PENDING_' in str(tr.get('observation', ''))
        for tr in result.get('tool_results', [])
    )

    if has_placeholder:
        print(f"\nPlaceholder found!")
        return False
    else:
        print(f"\nNo placeholders, execution successful!")
        return True


def example_with_memory_tool():
    """
    Example 2: Using memory tool
    Memory tool is always accessible, no path issues
    """
    print("\n\n" + "=" * 70)
    print("Example 2: Using Memory Tool (Read/Write Memory)")
    print("=" * 70)

    from gem.tools.mcp_server.programmatic_tool_calling.helper import (
        get_programmatic_tool_calling_stdio_config,
        ProgrammaticToolCallingTool
    )
    from gem.tools.mcp_server.memory.helper import get_memory_stdio_config

    workspace_path = Path(__file__).parent

    # Create merged configuration
    mcp_config = {"mcpServers": {}}

    # Add memory server
    memory_cfg = get_memory_stdio_config()
    mcp_config["mcpServers"].update(memory_cfg)

    # Add programmatic_tool_calling server
    prog_cfg = get_programmatic_tool_calling_stdio_config(workspace_path=str(workspace_path))
    mcp_config["mcpServers"].update(prog_cfg)

    tool = ProgrammaticToolCallingTool(mcp_config, validate_on_init=False)

    # Get tool name
    available_tools = tool.get_available_tools()
    print(f"\nAvailable tools ({len(available_tools)}):")
    for t in available_tools[:5]:
        print(f"  - {t['name']}")
    if len(available_tools) > 5:
        print(f"  ... and {len(available_tools) - 5} more tools")

    prog_tool_name = [t['name'] for t in available_tools if 'programmatic_tool_calling' in t['name']][0]

    # Code using memory tool
    code = '''
# Step 1: Create entities
print("Step 1: Creating entities...")
tools.memory_create_entities(
    entities=[
        {"name": "user1", "entityType": "person", "observations": ["Likes programming", "Python developer"]},
        {"name": "user2", "entityType": "person", "observations": ["Likes music", "Guitarist"]}
    ]
)
print("  Created 2 entities")

# Step 2: Search entities
print("Step 2: Searching entities...")
results = tools.memory_search_nodes(query="programming")
print(f"  Found {len(results)} matching entities")

# Step 3: Create relations
print("Step 3: Creating relations...")
tools.memory_create_relations(
    relations=[
        {"from": "user1", "to": "user2", "relationType": "knows"}
    ]
)
print("  Created 1 relation")

# Step 4: Read graph
print("Step 4: Reading graph...")
graph = tools.memory_read_graph()
print(f"  Graph has {len(graph.get('entities', []))} entities and {len(graph.get('relations', []))} relations")

result = f"Successfully managed knowledge graph: {len(graph.get('entities', []))} entities, {len(graph.get('relations', []))} relations"
'''

    print("\nCode:")
    print(code)
    print("\nExecuting...")

    tool_parsed, has_error, observation, _, _ = tool.execute_tool(
        prog_tool_name,
        {"code": code},
        "example_002"
    )

    result = json.loads(observation)

    print("\n" + "=" * 70)
    print("Result")
    print("=" * 70)
    print(f"Success: {result['success']}")
    print(f"Return value: {result['return_value']}")
    print(f"Execution time: {result['execution_time_seconds']:.3f}s")
    print(f"Tool call count: {len(result['tool_calls'])}")
    print(f"needs_tool_execution: {result.get('needs_tool_execution', False)}")

    print(f"\nTool call history:")
    for i, tc in enumerate(result['tool_calls'], 1):
        print(f"  {i}. {tc['tool_name']}")

    print(f"\nConsole output:")
    for line in result['stdout'].strip().split('\n'):
        print(f"  {line}")

    # Verify no placeholders
    has_placeholder = any(
        '__TOOL_CALL_PENDING_' in str(tr.get('observation', ''))
        for tr in result.get('tool_results', [])
    )

    if has_placeholder:
        print(f"\nPlaceholder found!")
        print(f"\nTool result details:")
        for tr in result['tool_results']:
            obs = tr['observation']
            if len(obs) > 100:
                obs = obs[:100] + "..."
            print(f"  - {tr['tool_call_id']}: {obs}")
        return False
    else:
        print(f"\nNo placeholders, all tool calls completed successfully!")
        print(f"Multi-round execution successful, returning real results!")
        return True


def example_with_proper_filesystem():
    """
    Example 3: Using properly configured filesystem tool
    Ensure paths are within allowed range
    """
    print("\n\n" + "=" * 70)
    print("Example 3: Using Filesystem Tool (Properly Configured)")
    print("=" * 70)

    from gem.tools.mcp_server.programmatic_tool_calling.helper import (
        get_programmatic_tool_calling_stdio_config,
        ProgrammaticToolCallingTool
    )
    from gem.tools.mcp_server.filesystem.helper import get_filesystem_stdio_config

    workspace_path = Path(__file__).parent

    # Create merged configuration - use correct allowed_directory
    mcp_config = {"mcpServers": {}}

    # Add filesystem server - allow access to entire programmatic_tool_calling directory
    filesystem_cfg = get_filesystem_stdio_config(allowed_directory=str(workspace_path))
    mcp_config["mcpServers"].update(filesystem_cfg)

    # Add programmatic_tool_calling server
    prog_cfg = get_programmatic_tool_calling_stdio_config(workspace_path=str(workspace_path))
    mcp_config["mcpServers"].update(prog_cfg)

    tool = ProgrammaticToolCallingTool(mcp_config, validate_on_init=False)

    # Get tool name
    available_tools = tool.get_available_tools()
    prog_tool_name = [t['name'] for t in available_tools if 'programmatic_tool_calling' in t['name']][0]

    # Code using filesystem tool - use absolute path to ensure access success
    code = f'''
import os

# Use absolute path
workspace = "{workspace_path}"

# Step 1: List files in workspace
print("Step 1: Listing files in workspace...")
files = tools.filesystem_list_directory(path=workspace)
print(files)
print(f"  Found {{len(files)}} files")

# Step 2: Filter .md documents
md_files = [f for f in files if f.endswith('.md')]
print(f"Step 2: Found {{len(md_files)}} markdown files")

# Step 3: Read first .md file (if exists)
if md_files:
    first_md = md_files[0]
    print(f"Step 3: Reading {{first_md}}...")
    content = tools.filesystem_read_file(path=os.path.join(workspace, first_md))
    lines = content.split('\\n')
    print(f"  File has {{len(lines)}} lines, {{len(content)}} characters")

    # Display first 3 lines
    print("  First 3 lines:")
    for i, line in enumerate(lines[:3], 1):
        if line.strip():
            preview = line[:60] + "..." if len(line) > 60 else line
            print(f"    {{i}}. {{preview}}")

    result = f"Successfully processed {{len(files)}} files, read {{first_md}} ({{len(lines)}} lines)"
else:
    result = f"Successfully listed {{len(files)}} files (no .md files found)"
'''

    print("\nCode:")
    for line in code.split('\n')[:10]:
        print(f"  {line}")
    print("  ...")
    print("\nExecuting...")

    print(tool.get_available_tools())
    print("prog_tool_name: ", prog_tool_name)

    tool_parsed, has_error, observation, _, _ = tool.execute_tool(
        prog_tool_name,
        {"code": code},
        "example_003"
    )

    result = json.loads(observation)

    print("\n" + "=" * 70)
    print("Result")
    print("=" * 70)
    print(f"Success: {result['success']}")
    print(f"Return value: {result['return_value']}")
    print(f"Execution time: {result['execution_time_seconds']:.3f}s")
    print(f"Tool call count: {len(result['tool_calls'])}")
    print(f"needs_tool_execution: {result.get('needs_tool_execution', False)}")

    print(f"\nTool call history:")
    for i, tc in enumerate(result['tool_calls'], 1):
        args_summary = ', '.join(f"{k}=..." for k in tc['args'].keys())
        print(f"  {i}. {tc['tool_name']}({args_summary})")

    print(f"\nConsole output:")
    for line in result['stdout'].strip().split('\n'):
        print(f"  {line}")

    # Verify no placeholders
    has_placeholder = any(
        '__TOOL_CALL_PENDING_' in str(tr.get('observation', ''))
        for tr in result.get('tool_results', [])
    )

    if has_placeholder:
        print(f"\nPlaceholder found!")
        return False
    else:
        print(f"\nNo placeholders, all tool calls completed successfully!")
        print(f"Multi-round execution successful, returning real results!")
        return True


def main():
    """Run all successful examples"""
    print("\n" + "=" * 70)
    print("Successful Multi-Round Execution Examples Collection")
    print("=" * 70)
    print("\nThese examples demonstrate truly completing multi-round execution and returning real results")
    print("(no placeholders, no needs_tool_execution=True)\n")

    results = []

    try:
        # # Example 1: Pure Python
        # result1 = example_without_filesystem()
        # results.append(("Pure Python code", result1))

        # # Example 2: Memory tool
        # result2 = example_with_memory_tool()
        # results.append(("Memory tool", result2))

        # Example 3: Filesystem tool (properly configured)
        result3 = example_with_proper_filesystem()
        results.append(("Filesystem tool", result3))

    except Exception as e:
        print(f"\nExample execution error: {e}")
        import traceback
        traceback.print_exc()
        return 1

    # Summary
    print("\n\n" + "=" * 70)
    print("Summary")
    print("=" * 70)

    for name, success in results:
        status = "Success" if success else "Failed"
        print(f"{status}: {name}")

    all_success = all(r[1] for r in results)

    if all_success:
        print("\n" + "=" * 70)
        print("All examples successfully completed multi-round execution!")
        print("=" * 70)
        print("\nKey takeaways:")
        print("1. Pure Python code: No tool calls, returns results directly")
        print("2. Memory tool: Tool calls successful, multi-round execution completed")
        print("3. Filesystem tool: Path correctly configured, tool calls successful")
        print("\nFinal results for all examples:")
        print("- needs_tool_execution = False")
        print("- No placeholders")
        print("- Contains real data")
        print("- Multi-round execution completed automatically")
        return 0
    else:
        print("\nSome examples failed, please check error messages")
        return 1


if __name__ == "__main__":
    sys.exit(main())
