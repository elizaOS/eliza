"""
Example script demonstrating Google Cloud MCP Tool usage.

This example shows:
1. How to create the tool using stdio mode (auto-starts server)
2. How to list available tools
3. How to execute various Google Cloud operations:
   - BigQuery: Run queries, list datasets/tables
   - Cloud Storage: List buckets, upload/download files
   - Compute Engine: List/manage VM instances
   - IAM: List/manage service accounts and roles

Usage:
    python example.py
"""

from gem.tools.mcp_server.google_cloud import create_google_cloud_tool_stdio


def main():
    print("=" * 80)
    print("Google Cloud MCP Tool Example")
    print("=" * 80)
    
    # Create the tool using stdio mode (auto-starts server)
    print("\n1. Creating Google Cloud MCP Tool (stdio mode)...")
    tool = create_google_cloud_tool_stdio(
        data_dir="./google_cloud_data",
        validate_on_init=False
    )
    print("✓ Tool created successfully")
    
    # List available tools
    print("\n2. Listing available tools...")
    tools = tool.get_available_tools()
    print(f"✓ Found {len(tools)} tools:")
    
    # Group tools by category (tools is a list of dicts with 'name' key)
    bigquery_tools = [t for t in tools if t['name'].startswith('bigquery_')]
    storage_tools = [t for t in tools if t['name'].startswith('storage_')]
    compute_tools = [t for t in tools if t['name'].startswith('compute_')]
    iam_tools = [t for t in tools if t['name'].startswith('iam_')]
    
    print(f"\n  BigQuery Tools ({len(bigquery_tools)}):")
    for tool_dict in bigquery_tools[:5]:  # Show first 5
        print(f"    - {tool_dict['name']}")
    if len(bigquery_tools) > 5:
        print(f"    ... and {len(bigquery_tools) - 5} more")
    
    print(f"\n  Cloud Storage Tools ({len(storage_tools)}):")
    for tool_dict in storage_tools[:5]:
        print(f"    - {tool_dict['name']}")
    if len(storage_tools) > 5:
        print(f"    ... and {len(storage_tools) - 5} more")
    
    print(f"\n  Compute Engine Tools ({len(compute_tools)}):")
    for tool_dict in compute_tools[:5]:
        print(f"    - {tool_dict['name']}")
    if len(compute_tools) > 5:
        print(f"    ... and {len(compute_tools) - 5} more")
    
    print(f"\n  IAM Tools ({len(iam_tools)}):")
    for tool_dict in iam_tools[:5]:
        print(f"    - {tool_dict['name']}")
    if len(iam_tools) > 5:
        print(f"    ... and {len(iam_tools) - 5} more")
    
    # Example 1: BigQuery - List datasets
    print("\n3. Example: List BigQuery datasets...")
    action = '''<tool_call>
<tool_name>bigquery_list_datasets</tool_name>
<parameters>
{}
</parameters>
</tool_call>'''
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    
    print(f"  Valid: {is_valid}, Has Error: {has_error}")
    if is_valid and not has_error:
        print("✓ Success:")
        print(f"  {obs[:200]}..." if len(obs) > 200 else f"  {obs}")
    else:
        print(f"✗ Error: {obs}")
        if parsed:
            print(f"  Parsed: {parsed}")
    
    # Example 2: Cloud Storage - List buckets
    print("\n4. Example: List Cloud Storage buckets...")
    action = '''<tool_call>
<tool_name>storage_list_buckets</tool_name>
<parameters>
{}
</parameters>
</tool_call>'''
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    
    print(f"  Valid: {is_valid}, Has Error: {has_error}")
    if is_valid and not has_error:
        print("✓ Success:")
        print(f"  {obs[:200]}..." if len(obs) > 200 else f"  {obs}")
    else:
        print(f"✗ Error: {obs}")
        if parsed:
            print(f"  Parsed: {parsed}")
    
    # Example 3: Compute Engine - List instances
    print("\n5. Example: List Compute Engine instances...")
    action = '''<tool_call>
<tool_name>compute_list_instances</tool_name>
<parameters>
{"zone": "us-central1-a"}
</parameters>
</tool_call>'''
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    
    print(f"  Valid: {is_valid}, Has Error: {has_error}")
    if is_valid and not has_error:
        print("✓ Success:")
        print(f"  {obs[:200]}..." if len(obs) > 200 else f"  {obs}")
    else:
        print(f"✗ Error: {obs}")
        if parsed:
            print(f"  Parsed: {parsed}")
    
    # Example 4: IAM - List service accounts
    print("\n6. Example: List IAM service accounts...")
    action = '''<tool_call>
<tool_name>iam_list_service_accounts</tool_name>
<parameters>
{}
</parameters>
</tool_call>'''
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    
    print(f"  Valid: {is_valid}, Has Error: {has_error}")
    if is_valid and not has_error:
        print("✓ Success:")
        print(f"  {obs[:200]}..." if len(obs) > 200 else f"  {obs}")
    else:
        print(f"✗ Error: {obs}")
        if parsed:
            print(f"  Parsed: {parsed}")
    
    print("\n" + "=" * 80)
    print("Example completed!")
    print("=" * 80)


if __name__ == "__main__":
    main()

