# Snowflake MCP Server Integration

This module provides integration with the Snowflake MCP server, which enables database queries and schema exploration through the Model Context Protocol.

## Overview

The Snowflake MCP server simulates Snowflake database functionality using a local SQLite database, making it ideal for testing and development. It supports:

- Database listing and schema exploration
- SQL query execution (SELECT, INSERT, UPDATE, DELETE)
- Table creation and management
- Data insights tracking

## Available Tools

| Tool | Description |
|------|-------------|
| `list_databases` | List all available databases in Snowflake |
| `list_schemas` | List all schemas in a database |
| `list_tables` | List all tables in a specific database and schema |
| `describe_table` | Get the schema information for a specific table |
| `read_query` | Execute a SELECT query |
| `write_query` | Execute an INSERT, UPDATE, or DELETE query |
| `create_table` | Create a new table in the database |
| `append_insight` | Add a data insight to the memo |

## Installation

No additional dependencies required beyond the gem package.

## Usage

### Method 1: stdio Mode (Recommended)

Auto-starts the Snowflake server via stdio - no manual setup needed:

```python
from gem.tools.mcp_server.snowflake import create_snowflake_tool_stdio

# Create tool (auto-starts server)
tool = create_snowflake_tool_stdio(
    data_dir="./snowflake_data",
    validate_on_init=False
)

# Get available tools
tools = tool.get_available_tools()
print(f"Available tools: {len(tools)}")

# List databases
action = '<tool_call><tool_name>list_databases</tool_name></tool_call>'
is_valid, has_error, obs, parsed = tool.execute_action(action)
print(obs)

# List schemas in a database
action = '<tool_call><tool_name>list_schemas</tool_name><parameters><database>PURCHASE_INVOICE</database></parameters></tool_call>'
is_valid, has_error, obs, parsed = tool.execute_action(action)
print(obs)

# Execute a query
action = '<tool_call><tool_name>read_query</tool_name><parameters><query>SELECT * FROM PURCHASE_INVOICE.PUBLIC.INVOICES LIMIT 5</query></parameters></tool_call>'
is_valid, has_error, obs, parsed = tool.execute_action(action)
print(obs)
```

### Method 2: HTTP Mode

Requires manual server startup first:

```bash
# Start the server
cd /path/to/mcp_convert/mcps/snowflake
python server.py --transport streamable-http --port 8086
```

```python
from gem.tools.mcp_server.snowflake import create_snowflake_tool_http

# Connect to running server
tool = create_snowflake_tool_http(
    snowflake_url="http://127.0.0.1:8086/snowflake-mcp",
    validate_on_init=False
)

# Use the tool
tools = tool.get_available_tools()
```

### Method 3: Multi-Server Configuration

Combine Snowflake with other MCP servers:

```python
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.snowflake import get_snowflake_stdio_config
from gem.tools.mcp_server.claim_done import get_claim_done_stdio_config

# Get individual configs
snowflake_config = get_snowflake_stdio_config(data_dir="./snowflake_data")
claim_done_config = get_claim_done_stdio_config()

# Merge configs
merged_config = {
    "mcpServers": {
        **snowflake_config,
        **claim_done_config
    }
}

# Create combined tool
tool = MCPTool(merged_config, validate_on_init=False)

# Now you can use tools from both servers
tools = tool.get_available_tools()
```

## Configuration Options

### `create_snowflake_tool_stdio`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data_dir` | str | `./snowflake_data` | Path to data directory |
| `server_script` | str | auto-detect | Path to server.py |
| `validate_on_init` | bool | False | Validate on initialization |

### `create_snowflake_tool_http`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `snowflake_url` | str | `http://127.0.0.1:8086/snowflake-mcp` | Server URL |
| `validate_on_init` | bool | False | Validate on initialization |

## Environment Variables

- `SNOWFLAKE_DATA_DIR`: Custom data directory path (overrides `data_dir` parameter)

## Example Tool Calls

### List Databases

```python
action = '<tool_call><tool_name>list_databases</tool_name></tool_call>'
```

### List Schemas

```python
action = '''<tool_call>
<tool_name>list_schemas</tool_name>
<parameters>
<database>PURCHASE_INVOICE</database>
</parameters>
</tool_call>'''
```

### List Tables

```python
action = '''<tool_call>
<tool_name>list_tables</tool_name>
<parameters>
<database>PURCHASE_INVOICE</database>
<schema>PUBLIC</schema>
</parameters>
</tool_call>'''
```

### Describe Table

```python
action = '''<tool_call>
<tool_name>describe_table</tool_name>
<parameters>
<table_name>PURCHASE_INVOICE.PUBLIC.INVOICES</table_name>
</parameters>
</tool_call>'''
```

### Read Query (SELECT)

```python
action = '''<tool_call>
<tool_name>read_query</tool_name>
<parameters>
<query>SELECT * FROM PURCHASE_INVOICE.PUBLIC.INVOICES WHERE INVOICE_AMOUNT > 1000 LIMIT 10</query>
</parameters>
</tool_call>'''
```

### Write Query (INSERT/UPDATE/DELETE)

```python
action = '''<tool_call>
<tool_name>write_query</tool_name>
<parameters>
<query>INSERT INTO PURCHASE_INVOICE.PUBLIC.INVOICES (INVOICE_ID, PURCHASER_EMAIL, SUPPLIER_NAME, INVOICE_AMOUNT) VALUES ('INV-001', 'test@example.com', 'Test Supplier', 1000)</query>
</parameters>
</tool_call>'''
```

### Create Table

```python
action = '''<tool_call>
<tool_name>create_table</tool_name>
<parameters>
<query>CREATE TABLE PURCHASE_INVOICE.PUBLIC.MY_TABLE (ID NUMBER NOT NULL, NAME TEXT, VALUE NUMBER)</query>
</parameters>
</tool_call>'''
```

### Append Insight

```python
action = '''<tool_call>
<tool_name>append_insight</tool_name>
<parameters>
<insight>The average invoice amount is $50,000</insight>
</parameters>
</tool_call>'''
```

## Database Structure

The Snowflake simulation uses SQLite and follows Snowflake's three-level hierarchy:

1. **Databases** - Top-level containers (e.g., PURCHASE_INVOICE, SLA_MONITOR)
2. **Schemas** - Second-level containers (e.g., PUBLIC, INFORMATION_SCHEMA)
3. **Tables** - Data tables within schemas

## Sample Databases

The server may include sample data from:

- **PURCHASE_INVOICE** - Invoice and payment data
- **SLA_MONITOR** - Support ticket tracking
- **LANDING_TASK_REMINDER** - Task management
- **TRAVEL_EXPENSE_REIMBURSEMENT** - Expense tracking

## Troubleshooting

### Server Script Not Found

If you see "Cannot find Snowflake server script" error:

```python
# Provide explicit path
tool = create_snowflake_tool_stdio(
    server_script="/path/to/mcp_convert/mcps/snowflake/server.py",
    data_dir="./snowflake_data"
)
```

### Data Directory Issues

Ensure the data directory exists and has proper permissions:

```python
import os
os.makedirs("./snowflake_data", exist_ok=True)
```

## References

- [MCP Protocol](https://modelcontextprotocol.io)
- [Original mcp-snowflake-server](https://github.com/modelcontextprotocol/servers/tree/main/src/snowflake)






