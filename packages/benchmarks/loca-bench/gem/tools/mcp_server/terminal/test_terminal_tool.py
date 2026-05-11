#!/usr/bin/env python3
"""Test script for Terminal MCP server integration."""

import json
import sys
import tempfile
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.terminal import create_terminal_tool


def test_basic_connection():
    """Test basic connection and tool discovery."""
    print("=" * 60)
    print("Testing Terminal MCP Server Connection")
    print("=" * 60)
    
    try:
        # Create tool with a temporary workspace
        with tempfile.TemporaryDirectory() as tmpdir:
            tool = create_terminal_tool(
                agent_workspace=tmpdir,
                validate_on_init=True
            )
        
        print("✓ Successfully created Terminal tool")
        
        # Get available tools
        tools = tool.get_available_tools()
        print(f"\n✓ Found {len(tools)} available tools:")
        for t in tools:
            print(f"  - {t['name']}: {t['description']}")
        
        return tool
        
    except Exception as e:
        print(f"\n✗ Failed to create Terminal tool: {e}")
        import traceback
        traceback.print_exc()
        return None


def test_simple_command(tool, command, description):
    """Test executing a simple command."""
    print("\n" + "=" * 60)
    print(f"Testing: {description}")
    print("=" * 60)
    
    action = f'''
<tool_call>
<tool_name>run_command</tool_name>
<arguments>
{{
  "command": "{command}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print(f"✓ Successfully executed: {command}")
            print(f"Output:\n{observation}")
        else:
            print(f"✗ Failed to execute command: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during command execution: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_file_operations(tool, test_dir):
    """Test file operations in the allowed directory."""
    print("\n" + "=" * 60)
    print("Testing File Operations")
    print("=" * 60)
    
    test_file = Path(test_dir) / "test_file.txt"
    
    # Test 1: Create a file with echo
    print("\n1. Creating a test file...")
    action1 = f'''
<tool_call>
<tool_name>run_command</tool_name>
<arguments>
{{
  "command": "echo 'Hello from Terminal MCP' > {test_file}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action1)
        if is_valid and not has_error:
            print(f"✓ Created file: {test_file}")
        else:
            print(f"✗ Failed to create file: {observation}")
            return False
    except Exception as e:
        print(f"✗ Exception: {e}")
        return False
    
    # Test 2: Read the file
    print("\n2. Reading the test file...")
    action2 = f'''
<tool_call>
<tool_name>run_command</tool_name>
<arguments>
{{
  "command": "cat {test_file}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action2)
        if is_valid and not has_error:
            print(f"✓ Read file successfully")
            print(f"Content: {observation}")
        else:
            print(f"✗ Failed to read file: {observation}")
            return False
    except Exception as e:
        print(f"✗ Exception: {e}")
        return False
    
    # Test 3: List directory
    print("\n3. Listing directory...")
    action3 = f'''
<tool_call>
<tool_name>run_command</tool_name>
<arguments>
{{
  "command": "ls -la {test_dir}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action3)
        if is_valid and not has_error:
            print(f"✓ Listed directory successfully")
            print(f"Contents:\n{observation}")
        else:
            print(f"✗ Failed to list directory: {observation}")
            return False
    except Exception as e:
        print(f"✗ Exception: {e}")
        return False
    
    return True


def test_piped_commands(tool, test_dir):
    """Test commands with pipes (if shell operators are allowed)."""
    print("\n" + "=" * 60)
    print("Testing Piped Commands")
    print("=" * 60)
    
    # Test piped command
    action = f'''
<tool_call>
<tool_name>run_command</tool_name>
<arguments>
{{
  "command": "echo 'line1\\nline2\\nline3' | grep line2"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Successfully executed piped command")
            print(f"Output: {observation}")
        else:
            print(f"✗ Failed to execute piped command: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during piped command: {e}")
        return False


def test_instruction_string(tool):
    """Test instruction string generation."""
    print("\n" + "=" * 60)
    print("Testing Instruction String")
    print("=" * 60)
    
    instruction = tool.instruction_string()
    
    print("\nGenerated instruction string (first 1000 chars):")
    print("-" * 60)
    print(instruction[:1000])
    print("...")
    print("-" * 60)
    
    return True


def test_show_security_rules(tool):
    """Test showing security rules."""
    print("\n" + "=" * 60)
    print("Testing Show Security Rules")
    print("=" * 60)
    
    action = '''
<tool_call>
<tool_name>show_security_rules</tool_name>
<arguments>
{}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Successfully retrieved security rules")
            print(f"Output:\n{observation}")
        else:
            print(f"✗ Failed to retrieve security rules: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during show security rules: {e}")
        return False


def main():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("Terminal MCP Server Test Suite")
    print("=" * 60)
    print("\nNote: This will use 'uvx cli-mcp-server'")
    print("Make sure cli-mcp-server is available via uvx\n")
    
    # Create a temporary directory for testing
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"Using temporary workspace: {tmpdir}\n")
        
        # Test connection
        print("Creating tool with temporary workspace...")
        try:
            tool = create_terminal_tool(
                agent_workspace=tmpdir,
                validate_on_init=True
            )
            print("✓ Successfully created Terminal tool")
            
            # Get available tools
            tools = tool.get_available_tools()
            print(f"\n✓ Found {len(tools)} available tools:")
            for t in tools:
                print(f"  - {t['name']}: {t['description']}")
        except Exception as e:
            print(f"\n✗ Connection test failed: {e}")
            print("\nMake sure cli-mcp-server is available:")
            print("  uv tool install cli-mcp-server")
            print("  or just use: uvx cli-mcp-server (auto-installs)")
            import traceback
            traceback.print_exc()
            return 1
        
        # Test instruction string
        test_instruction_string(tool)
        
        # Test showing security rules
        test_show_security_rules(tool)
        
        # Test simple commands
        test_simple_command(tool, "pwd", "Print working directory")
        test_simple_command(tool, "echo 'Hello, Terminal MCP!'", "Echo command")
        test_simple_command(tool, "date", "Current date and time")
        test_simple_command(tool, "whoami", "Current user")
        
        # Test file operations
        test_file_operations(tool, tmpdir)
        
        # Test piped commands
        test_piped_commands(tool, tmpdir)
        
        print("\n" + "=" * 60)
        print("Test Suite Complete")
        print("=" * 60)
        
        # Cleanup
        tool.close()
        print("\n✓ Tool closed successfully")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())

