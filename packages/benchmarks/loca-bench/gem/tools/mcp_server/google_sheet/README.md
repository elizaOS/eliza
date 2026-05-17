# Google Sheet MCP Tool

A Model Context Protocol (MCP) tool for interacting with Google Sheets. This tool provides a local implementation using JSON files as the database, making it perfect for development and testing without requiring actual Google account credentials or API access.

## Features

### Supported Operations

- **Spreadsheet Management**: Create, list, and share spreadsheets
- **Sheet Operations**: Create, rename, copy, and list sheets
- **Data Operations**: Read and write cell data, formulas, and formatting
- **Structure Modifications**: Add rows, add columns, batch updates

### Key Capabilities

- **Data Access**:
  - Get cell data with optional range specification
  - Get formulas from cells
  - Get grid data with formatting metadata
  - Get data from multiple sheets in one call
  - Get summary of multiple spreadsheets

- **Data Modification**:
  - Update individual cell ranges
  - Batch update multiple ranges
  - Insert and manipulate data

- **Sheet Management**:
  - List all sheets in a spreadsheet
  - Create new sheets
  - Rename sheets
  - Copy sheets between spreadsheets

- **Spreadsheet Management**:
  - List all spreadsheets
  - Create new spreadsheets
  - Share spreadsheets with specific permissions

## Installation

The Google Sheet MCP Tool is part of the `gem` package. Make sure you have the required dependencies:

```bash
pip install gem
# or if using uv
uv pip install gem
```

## Usage

### Method 1: stdio Mode (Recommended)

The stdio mode auto-starts the server - no manual setup required!

```python
from gem.tools.mcp_server.google_sheet import create_google_sheet_tool_stdio

# Create the tool
tool = create_google_sheet_tool_stdio(
    data_dir="./google_sheet_data",  # Local database directory
    validate_on_init=False
)

# List available tools
tools = tool.get_available_tools()
print(f"Available tools: {len(tools)}")

# List all spreadsheets
action = '<tool_call><tool_name>list_spreadsheets</tool_name></tool_call>'
is_valid, has_error, obs, parsed = tool.execute_action(action)

# Get sheet data
action = '''<tool_call>
<tool_name>get_sheet_data</tool_name>
<parameters>
<spreadsheet_id>abc123</spreadsheet_id>
<sheet>Sheet1</sheet>
<range>A1:C10</range>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)

# Update cells
action = '''<tool_call>
<tool_name>update_cells</tool_name>
<parameters>
<spreadsheet_id>abc123</spreadsheet_id>
<sheet>Sheet1</sheet>
<range>A1:B2</range>
<data>[[1, 2], [3, 4]]</data>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
```

### Method 2: HTTP Mode

For HTTP mode, you need to start the server manually first:

```bash
# Start the server
cd /path/to/mcp_convert
uv run python mcps/google_sheet/server.py --transport streamable-http --port 8086
```

Then in Python:

```python
from gem.tools.mcp_server.google_sheet import create_google_sheet_tool_http

# Connect to running server
tool = create_google_sheet_tool_http(
    google_sheet_url="http://127.0.0.1:8086/google-sheet-mcp",
    validate_on_init=False
)

# Use the tool
tools = tool.get_available_tools()
```

### Multi-Server Configuration

Combine Google Sheet with other MCP servers:

```python
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.google_sheet import get_google_sheet_stdio_config
from gem.tools.mcp_server.emails import get_email_stdio_config

# Get individual server configs
gsheet_config = get_google_sheet_stdio_config(data_dir="./google_sheet_data")
email_config = get_email_stdio_config(data_dir="./email_data")

# Merge configs
merged_config = {
    "mcpServers": {
        **gsheet_config,
        **email_config
    }
}

# Create combined tool
tool = MCPTool(merged_config, validate_on_init=False)

# Now you can use both Google Sheet and Email tools!
```

## Configuration

### Environment Variables

- `GOOGLE_SHEET_DATA_DIR`: Path to the local database directory
  - If not set, defaults to `./google_sheet_data`
  - The directory will be created automatically if it doesn't exist

## Available Tools

The Google Sheet MCP Tool provides 15 tools:

1. **get_sheet_data** - Get data from a specific sheet
2. **get_sheet_formulas** - Get formulas from a sheet
3. **update_cells** - Update cells in a spreadsheet
4. **batch_update_cells** - Batch update multiple ranges
5. **add_rows** - Add rows to a sheet
6. **add_columns** - Add columns to a sheet
7. **list_sheets** - List all sheets in a spreadsheet
8. **copy_sheet** - Copy a sheet from one spreadsheet to another
9. **rename_sheet** - Rename a sheet
10. **get_multiple_sheet_data** - Get data from multiple ranges
11. **get_multiple_spreadsheet_summary** - Get summary of multiple spreadsheets
12. **create_spreadsheet** - Create a new spreadsheet
13. **create_sheet** - Create a new sheet in a spreadsheet
14. **list_spreadsheets** - List all spreadsheets
15. **share_spreadsheet** - Share a spreadsheet with users

## Examples

### Example 1: Create and Populate a Spreadsheet

```python
tool = create_google_sheet_tool_stdio()

# Create a new spreadsheet
action = '''<tool_call>
<tool_name>create_spreadsheet</tool_name>
<parameters>
<title>Sales Report 2024</title>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
# Extract spreadsheet_id from response

# Update cells with headers
action = '''<tool_call>
<tool_name>update_cells</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
<range>A1:D1</range>
<data>[["Date", "Product", "Quantity", "Revenue"]]</data>
</parameters>
</tool_call>'''
tool.execute_action(action)

# Add data rows
action = '''<tool_call>
<tool_name>update_cells</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
<range>A2:D4</range>
<data>[
    ["2024-01-01", "Widget A", 100, 1000],
    ["2024-01-02", "Widget B", 150, 2250],
    ["2024-01-03", "Widget A", 200, 2000]
]</data>
</parameters>
</tool_call>'''
tool.execute_action(action)
```

### Example 2: Read and Analyze Data

```python
tool = create_google_sheet_tool_stdio()

# Get all data from a sheet
action = '''<tool_call>
<tool_name>get_sheet_data</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)

# Get specific range
action = '''<tool_call>
<tool_name>get_sheet_data</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
<range>A1:D10</range>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)

# Get formulas
action = '''<tool_call>
<tool_name>get_sheet_formulas</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
<range>E1:E10</range>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
```

### Example 3: Sheet Management

```python
tool = create_google_sheet_tool_stdio()

# List all sheets in a spreadsheet
action = '''<tool_call>
<tool_name>list_sheets</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
</parameters>
</tool_call>'''
tool.execute_action(action)

# Create a new sheet
action = '''<tool_call>
<tool_name>create_sheet</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<title>Q1 Summary</title>
</parameters>
</tool_call>'''
tool.execute_action(action)

# Rename a sheet
action = '''<tool_call>
<tool_name>rename_sheet</tool_name>
<parameters>
<spreadsheet>SPREADSHEET_ID</spreadsheet>
<sheet>Sheet1</sheet>
<new_name>Raw Data</new_name>
</parameters>
</tool_call>'''
tool.execute_action(action)

# Copy sheet to another spreadsheet
action = '''<tool_call>
<tool_name>copy_sheet</tool_name>
<parameters>
<src_spreadsheet>SOURCE_ID</src_spreadsheet>
<src_sheet>Sheet1</src_sheet>
<dst_spreadsheet>DEST_ID</dst_spreadsheet>
<dst_sheet>Imported Data</dst_sheet>
</parameters>
</tool_call>'''
tool.execute_action(action)
```

### Example 4: Batch Operations

```python
tool = create_google_sheet_tool_stdio()

# Batch update multiple ranges
action = '''<tool_call>
<tool_name>batch_update_cells</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
<ranges>{
    "A1:B2": [["Header1", "Header2"], ["Value1", "Value2"]],
    "D1:E2": [["Col3", "Col4"], ["Data3", "Data4"]]
}</ranges>
</parameters>
</tool_call>'''
tool.execute_action(action)

# Get data from multiple ranges
action = '''<tool_call>
<tool_name>get_multiple_sheet_data</tool_name>
<parameters>
<queries>[
    {"spreadsheet_id": "ID1", "sheet": "Sheet1", "range": "A1:C10"},
    {"spreadsheet_id": "ID2", "sheet": "Data", "range": "A1:B5"}
]</queries>
</parameters>
</tool_call>'''
tool.execute_action(action)

# Get summary of multiple spreadsheets
action = '''<tool_call>
<tool_name>get_multiple_spreadsheet_summary</tool_name>
<parameters>
<spreadsheet_ids>["ID1", "ID2", "ID3"]</spreadsheet_ids>
<rows_to_fetch>10</rows_to_fetch>
</parameters>
</tool_call>'''
tool.execute_action(action)
```

### Example 5: Sharing Spreadsheets

```python
tool = create_google_sheet_tool_stdio()

# Share spreadsheet with multiple users
action = '''<tool_call>
<tool_name>share_spreadsheet</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<recipients>[
    {"email_address": "user1@example.com", "role": "writer"},
    {"email_address": "user2@example.com", "role": "reader"},
    {"email_address": "user3@example.com", "role": "commenter"}
]</recipients>
<send_notification>true</send_notification>
</parameters>
</tool_call>'''
tool.execute_action(action)
```

### Example 6: Add Rows and Columns

```python
tool = create_google_sheet_tool_stdio()

# Add 5 rows at the end of the sheet
action = '''<tool_call>
<tool_name>add_rows</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
<count>5</count>
</parameters>
</tool_call>'''
tool.execute_action(action)

# Add 3 columns at the beginning
action = '''<tool_call>
<tool_name>add_columns</tool_name>
<parameters>
<spreadsheet_id>SPREADSHEET_ID</spreadsheet_id>
<sheet>Sheet1</sheet>
<count>3</count>
<start_column>0</start_column>
</parameters>
</tool_call>'''
tool.execute_action(action)
```

## Running the Example

```bash
cd /path/to/gem/gem/tools/mcp_server/google_sheet
python example.py
```

Run different examples:

```bash
python example.py stdio      # stdio mode example
python example.py http       # HTTP mode example
python example.py multi      # Multi-server example
python example.py advanced   # Advanced operations
```

## Data Storage

All data is stored locally in JSON files within the specified `data_dir`:

```
google_sheet_data/
├── spreadsheets.json      # Spreadsheet metadata
├── sheets.json            # Sheet information
└── data/                  # Cell data organized by spreadsheet
    ├── spreadsheet_1.json
    ├── spreadsheet_2.json
    └── ...
```

## Benefits

1. **No Google Account Required**: Works entirely offline with local JSON storage
2. **Fast Development**: No network latency or API quotas
3. **Reproducible**: Same data across different environments
4. **Cost-Free**: No API charges or rate limits
5. **Easy Testing**: Perfect for unit tests and integration tests
6. **Privacy**: All data stays local, no cloud sync

## Architecture

The Google Sheet MCP Tool follows the same pattern as other MCP tools:

```
gem/tools/mcp_server/google_sheet/
├── __init__.py          # Public API exports
├── helper.py            # Tool creation functions
├── example.py           # Usage examples
└── README.md            # This file

mcp_convert/mcps/google_sheet/
├── server.py            # MCP server implementation
├── database_utils.py    # Local JSON database
└── data/                # Default data directory
```

## Related Tools

- [Google Cloud MCP Tool](../google_cloud/README.md) - Google Cloud Platform integration
- [Email MCP Tool](../emails/README.md) - Email management system
- [Excel MCP Tool](../excel/README.md) - Excel file operations
- [Canvas MCP Tool](../canvas/README.md) - Learning management system

## License

See the main gem project license.









