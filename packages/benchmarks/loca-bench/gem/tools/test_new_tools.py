#!/usr/bin/env python
"""
Test script for new tools: PythonExecutorTool and OverlongOutputTool

This script demonstrates the usage of the newly added tools.
"""

import os
import tempfile
from pathlib import Path

# Test 1: PythonExecutorTool
print("=" * 80)
print("Test 1: PythonExecutorTool")
print("=" * 80)

from gem.tools.python_executor_tool import PythonExecutorTool

# Create a temporary workspace
temp_workspace = tempfile.mkdtemp(prefix="gem_test_")
print(f"Created temporary workspace: {temp_workspace}")

# Initialize the tool
executor = PythonExecutorTool(workspace_dir=temp_workspace)

# Test basic execution
print("\n--- Test 1.1: Basic Execution ---")
action1 = """
<python_execute>
<code>
print("Hello from PythonExecutorTool!")
print("2 + 2 =", 2 + 2)
</code>
</python_execute>
"""

is_valid, has_error, observation, parsed_action = executor.execute_action(action1)
print(f"Valid: {is_valid}")
print(f"Has Error: {has_error}")
print(f"Observation: {observation}")

# Test with filename and timeout
print("\n--- Test 1.2: With Filename and Timeout ---")
action2 = """
<python_execute>
<code>
import time
print("Starting...")
time.sleep(0.5)
print("Done!")
</code>
<filename>my_script.py</filename>
<timeout>10</timeout>
</python_execute>
"""

is_valid, has_error, observation, parsed_action = executor.execute_action(action2)
print(f"Valid: {is_valid}")
print(f"Has Error: {has_error}")
print(f"Observation: {observation}")

# Test error handling
print("\n--- Test 1.3: Error Handling ---")
action3 = """
<python_execute>
<code>
print("This will cause an error")
raise ValueError("Test error")
</code>
</python_execute>
"""

is_valid, has_error, observation, parsed_action = executor.execute_action(action3)
print(f"Valid: {is_valid}")
print(f"Has Error: {has_error}")
print(f"Observation: {observation}")

# Test instruction string
print("\n--- Test 1.4: Instruction String ---")
print(executor.instruction_string())

# Test 2: OverlongOutputTool
print("\n" + "=" * 80)
print("Test 2: OverlongOutputTool")
print("=" * 80)

from gem.tools.overlong_output_tool import OverlongOutputTool

# Create overlong output directory and sample file
overlong_dir = Path(temp_workspace) / ".overlong_tool_outputs"
overlong_dir.mkdir(parents=True, exist_ok=True)

# Create a sample overlong output file
sample_uuid = "test123"
sample_content = """Line 1: This is a test file
Line 2: It contains some search terms
Line 3: Python is a great language
Line 4: Machine learning is fascinating
Line 5: The quick brown fox jumps over the lazy dog
Line 6: Python programming is fun
Line 7: Natural language processing
Line 8: Deep learning and neural networks
Line 9: Python has many libraries
Line 10: End of sample content
""" * 10  # Make it longer

sample_file = overlong_dir / f"{sample_uuid}.json"
with open(sample_file, 'w', encoding='utf-8') as f:
    f.write(sample_content)

print(f"Created sample file: {sample_file}")

# Initialize the tool
overlong_tool = OverlongOutputTool(workspace_dir=temp_workspace)

# Test list operation
print("\n--- Test 2.1: List Files ---")
action1 = "<overlong_list></overlong_list>"

is_valid, has_error, observation, parsed_action = overlong_tool.execute_action(action1)
print(f"Valid: {is_valid}")
print(f"Has Error: {has_error}")
print(f"Observation: {observation}")

# Test search operation
print("\n--- Test 2.2: Search ---")
action2 = f"""
<overlong_search>
<shortuuid>{sample_uuid}</shortuuid>
<pattern>Python.*language</pattern>
<page_size>5</page_size>
</overlong_search>
"""

is_valid, has_error, observation, parsed_action = overlong_tool.execute_action(action2)
print(f"Valid: {is_valid}")
print(f"Has Error: {has_error}")
print(f"Observation: {observation[:500]}...")  # Truncate for readability

# Test view operation
print("\n--- Test 2.3: View ---")
action3 = f"""
<overlong_view>
<shortuuid>{sample_uuid}</shortuuid>
<page_size>500</page_size>
</overlong_view>
"""

is_valid, has_error, observation, parsed_action = overlong_tool.execute_action(action3)
print(f"Valid: {is_valid}")
print(f"Has Error: {has_error}")
print(f"Observation: {observation[:500]}...")  # Truncate for readability

# Test instruction string
print("\n--- Test 2.4: Instruction String ---")
print(overlong_tool.instruction_string())

# Test 3: Import from package
print("\n" + "=" * 80)
print("Test 3: Package Imports")
print("=" * 80)

try:
    from gem.tools import (
        PythonCodeTool,
        PythonExecutorTool,
        SearchTool,
        OverlongOutputTool,
        MCPTool,
        BaseTool,
    )
    print("✓ All imports successful!")
    print(f"  - PythonCodeTool: {PythonCodeTool}")
    print(f"  - PythonExecutorTool: {PythonExecutorTool}")
    print(f"  - SearchTool: {SearchTool}")
    print(f"  - OverlongOutputTool: {OverlongOutputTool}")
    print(f"  - MCPTool: {MCPTool}")
    print(f"  - BaseTool: {BaseTool}")
except Exception as e:
    print(f"✗ Import failed: {e}")

# Cleanup
print("\n" + "=" * 80)
print("Cleanup")
print("=" * 80)
import shutil
shutil.rmtree(temp_workspace)
print(f"Removed temporary workspace: {temp_workspace}")

print("\n" + "=" * 80)
print("All tests completed!")
print("=" * 80)
