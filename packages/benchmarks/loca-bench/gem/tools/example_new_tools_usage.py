#!/usr/bin/env python
"""
Example: Using PythonExecutorTool and OverlongOutputTool in a real scenario

This example demonstrates how to use these tools together:
1. Execute Python code that generates long output
2. Store the output in overlong storage
3. Search and view the results
"""

import json
import tempfile
import uuid
from pathlib import Path

from gem.tools import PythonExecutorTool, OverlongOutputTool

# Setup
workspace = tempfile.mkdtemp(prefix="gem_example_")
print(f"Workspace: {workspace}")
print("=" * 80)

# Initialize tools
executor = PythonExecutorTool(workspace_dir=workspace)
overlong = OverlongOutputTool(workspace_dir=workspace)

# ============================================================================
# Scenario 1: Execute code and capture long output
# ============================================================================
print("\n📝 Scenario 1: Generate and store long output")
print("-" * 80)

# Execute code that generates long output
code_action = """
<python_execute>
<code>
# Generate a report with many entries
for i in range(100):
    print(f"Entry {i}: Processing data...")
    print(f"  Status: {'Success' if i % 3 != 0 else 'Error'}")
    print(f"  Value: {i * 42}")
    print()
</code>
<filename>generate_report.py</filename>
</python_execute>
"""

is_valid, has_error, observation, _ = executor.execute_action(code_action)
print(f"Execution valid: {is_valid}")
print(f"Has error: {has_error}")
print(f"Output length: {len(observation)} characters")

# Store the long output
output_uuid = str(uuid.uuid4())[:8]
overlong_dir = Path(workspace) / ".overlong_tool_outputs"
overlong_dir.mkdir(parents=True, exist_ok=True)

output_file = overlong_dir / f"{output_uuid}.json"
with open(output_file, 'w', encoding='utf-8') as f:
    f.write(observation)

print(f"Stored output as: {output_uuid}")

# ============================================================================
# Scenario 2: List and search stored outputs
# ============================================================================
print("\n\n🔍 Scenario 2: Search for errors in output")
print("-" * 80)

# List files
list_action = "<overlong_list></overlong_list>"
_, _, list_result, _ = overlong.execute_action(list_action)
print("Available files:")
print(list_result[:300], "...")

# Search for errors
search_action = f"""
<overlong_search>
<shortuuid>{output_uuid}</shortuuid>
<pattern>Status: Error</pattern>
<page_size>3</page_size>
<context_size>200</context_size>
</overlong_search>
"""

_, _, search_result, _ = overlong.execute_action(search_action)
print("\nSearch results for 'Status: Error':")
print(search_result[:800], "...")

# ============================================================================
# Scenario 3: View specific sections
# ============================================================================
print("\n\n👁️  Scenario 3: View output content")
print("-" * 80)

view_action = f"""
<overlong_view>
<shortuuid>{output_uuid}</shortuuid>
<page_size>1000</page_size>
</overlong_view>
"""

_, _, view_result, _ = overlong.execute_action(view_action)
print("First page of output:")
print(view_result[:600], "...")

# ============================================================================
# Scenario 4: Complex data processing
# ============================================================================
print("\n\n📊 Scenario 4: Data analysis with dependencies")
print("-" * 80)

analysis_action = """
<python_execute>
<code>
# Example: Data analysis (works if pandas is available in uv environment)
import sys

# Generate sample data
data = [(i, i**2, i**3) for i in range(10)]

# Simple analysis without pandas
print("Data Analysis Results")
print("=" * 60)
print()

for i, (x, x2, x3) in enumerate(data):
    print(f"Point {i}:")
    print(f"  x={x}, x²={x2}, x³={x3}")
    
print()
print("Summary:")
print(f"  Total points: {len(data)}")
print(f"  Sum of squares: {sum(x2 for _, x2, _ in data)}")
print(f"  Sum of cubes: {sum(x3 for _, _, x3 in data)}")
</code>
<filename>data_analysis.py</filename>
<timeout>60</timeout>
</python_execute>
"""

is_valid, has_error, analysis_result, _ = executor.execute_action(analysis_action)
print(f"Analysis valid: {is_valid}")
print(f"Has error: {has_error}")
print("\nAnalysis output:")
print(analysis_result)

# ============================================================================
# Scenario 5: Error handling demonstration
# ============================================================================
print("\n\n⚠️  Scenario 5: Handling execution errors")
print("-" * 80)

error_action = """
<python_execute>
<code>
def divide_numbers(a, b):
    return a / b

results = []
for i in range(-2, 3):
    try:
        result = divide_numbers(10, i)
        results.append(f"10 / {i} = {result}")
    except ZeroDivisionError:
        results.append(f"10 / {i} = ERROR: Division by zero!")

for r in results:
    print(r)
</code>
</python_execute>
"""

is_valid, has_error, error_result, _ = executor.execute_action(error_action)
print(f"Execution valid: {is_valid}")
print(f"Has error: {has_error}")
print("\nError handling output:")
print(error_result)

# ============================================================================
# Cleanup
# ============================================================================
print("\n" + "=" * 80)
print("🧹 Cleanup")
print("-" * 80)

import shutil
shutil.rmtree(workspace)
print(f"Removed workspace: {workspace}")

print("\n" + "=" * 80)
print("✅ All scenarios completed successfully!")
print("=" * 80)

# ============================================================================
# Summary
# ============================================================================
print("\n📌 Summary of demonstrated features:")
print("  ✓ Python code execution with uv run")
print("  ✓ Long output storage and management")
print("  ✓ Pattern-based searching")
print("  ✓ Paginated viewing")
print("  ✓ Custom timeout and filename")
print("  ✓ Error handling")
print("\n💡 These tools can be integrated into any GEM environment!")
