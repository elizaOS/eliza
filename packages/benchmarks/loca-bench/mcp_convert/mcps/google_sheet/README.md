# Google Sheets MCP Server

A Model Context Protocol (MCP) server that provides Google Sheets functionality using local JSON files as the database instead of connecting to external APIs.

## Overview

This server implements a complete local version of the Google Sheets API, allowing you to:
- Create and manage spreadsheets
- Create and manage sheets within spreadsheets
- Read and write cell data
- Work with formulas
- Batch update operations
- Copy and rename sheets
- Share spreadsheets
- Query multiple spreadsheets

All data is stored locally in JSON files, making it perfect for testing, development, and offline work.

## Features

### Spreadsheet Management
- **create_spreadsheet**: Create new spreadsheets
- **list_spreadsheets**: List all available spreadsheets
- **get_multiple_spreadsheet_summary**: Get summaries of multiple spreadsheets

### Sheet Management
- **create_sheet**: Add new sheets to a spreadsheet
- **list_sheets**: List all sheets in a spreadsheet
- **rename_sheet**: Rename existing sheets
- **copy_sheet**: Copy sheets between spreadsheets
- **add_rows**: Add rows to a sheet
- **add_columns**: Add columns to a sheet

### Data Operations
- **get_sheet_data**: Read cell data from sheets
- **get_sheet_formulas**: Get formulas from cells
- **update_cells**: Update cell values
- **batch_update_cells**: Update multiple ranges at once
- **get_multiple_sheet_data**: Query data from multiple sheets

### Sharing
- **share_spreadsheet**: Share spreadsheets with users (simulated)

## Installation

```bash
# Install dependencies
pip install -r requirements.txt

# Or if using the project structure
cd /path/to/mcp_bench/mcp-convert
```

## Usage

### Running the Server

```bash
python mcps/google_sheet/server.py
```

### Environment Variables

- `GOOGLE_SHEET_DATA_DIR`: Custom data directory for storing spreadsheet data (optional)

### Tool Examples

#### 1. Create a Spreadsheet

```json
{
  "tool": "create_spreadsheet",
  "arguments": {
    "title": "My Budget 2024"
  }
}
```

Response:
```json
{
  "spreadsheetId": "uuid-here",
  "title": "My Budget 2024",
  "folder": "root"
}
```

#### 2. Create a Sheet

```json
{
  "tool": "create_sheet",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "title": "January"
  }
}
```

#### 3. Update Cells

```json
{
  "tool": "update_cells",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "sheet": "Sheet1",
    "range": "A1",
    "data": [
      ["Name", "Age", "City"],
      ["Alice", "30", "NYC"],
      ["Bob", "25", "LA"]
    ]
  }
}
```

#### 4. Get Sheet Data

```json
{
  "tool": "get_sheet_data",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "sheet": "Sheet1",
    "range": "A1:C3",
    "include_grid_data": false
  }
}
```

Response:
```json
{
  "spreadsheetId": "uuid-here",
  "valueRanges": [{
    "range": "Sheet1!A1:C3",
    "values": [
      ["Name", "Age", "City"],
      ["Alice", "30", "NYC"],
      ["Bob", "25", "LA"]
    ]
  }]
}
```

#### 5. Work with Formulas

```json
{
  "tool": "update_cells",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "sheet": "Sheet1",
    "range": "A1",
    "data": [
      ["10", "20", "=A1+B1"]
    ]
  }
}
```

Get formulas:
```json
{
  "tool": "get_sheet_formulas",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "sheet": "Sheet1",
    "range": "A1:C1"
  }
}
```

#### 6. Batch Update Multiple Ranges

```json
{
  "tool": "batch_update_cells",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "sheet": "Sheet1",
    "ranges": {
      "A1:B2": [["1", "2"], ["3", "4"]],
      "D1:E2": [["a", "b"], ["c", "d"]]
    }
  }
}
```

#### 7. Add Rows or Columns

```json
{
  "tool": "add_rows",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "sheet": "Sheet1",
    "count": 5,
    "start_row": 10
  }
}
```

```json
{
  "tool": "add_columns",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "sheet": "Sheet1",
    "count": 3,
    "start_column": 5
  }
}
```

#### 8. Copy Sheet

```json
{
  "tool": "copy_sheet",
  "arguments": {
    "src_spreadsheet": "source-uuid",
    "src_sheet": "Sheet1",
    "dst_spreadsheet": "dest-uuid",
    "dst_sheet": "CopiedSheet"
  }
}
```

#### 9. Rename Sheet

```json
{
  "tool": "rename_sheet",
  "arguments": {
    "spreadsheet": "uuid-here",
    "sheet": "Sheet1",
    "new_name": "Budget"
  }
}
```

#### 10. List Sheets

```json
{
  "tool": "list_sheets",
  "arguments": {
    "spreadsheet_id": "uuid-here"
  }
}
```

Response:
```json
["Sheet1", "Sheet2", "Budget"]
```

#### 11. List Spreadsheets

```json
{
  "tool": "list_spreadsheets",
  "arguments": {}
}
```

Response:
```json
[
  {"id": "uuid-1", "title": "My Budget 2024"},
  {"id": "uuid-2", "title": "Project Plan"}
]
```

#### 12. Get Multiple Sheet Data

```json
{
  "tool": "get_multiple_sheet_data",
  "arguments": {
    "queries": [
      {
        "spreadsheet_id": "uuid-1",
        "sheet": "Sheet1",
        "range": "A1:B5"
      },
      {
        "spreadsheet_id": "uuid-2",
        "sheet": "Data",
        "range": "C1:C10"
      }
    ]
  }
}
```

#### 13. Get Multiple Spreadsheet Summary

```json
{
  "tool": "get_multiple_spreadsheet_summary",
  "arguments": {
    "spreadsheet_ids": ["uuid-1", "uuid-2"],
    "rows_to_fetch": 5
  }
}
```

Response includes spreadsheet titles, sheet names, headers, and first few rows of data.

#### 14. Share Spreadsheet

```json
{
  "tool": "share_spreadsheet",
  "arguments": {
    "spreadsheet_id": "uuid-here",
    "recipients": [
      {
        "email_address": "user1@example.com",
        "role": "writer"
      },
      {
        "email_address": "user2@example.com",
        "role": "reader"
      }
    ],
    "send_notification": true
  }
}
```

Response:
```json
{
  "successes": [
    {
      "email_address": "user1@example.com",
      "role": "writer",
      "permissionId": "perm-uuid-1"
    }
  ],
  "failures": []
}
```

## Data Storage

All data is stored in JSON files in the `data/` directory:

- `spreadsheets.json`: Spreadsheet metadata
- `sheets.json`: Sheet information
- `cells.json`: Cell data and formulas
- `permissions.json`: Sharing permissions

## A1 Notation Support

The server supports standard A1 notation for ranges:
- `A1`: Single cell
- `A1:B5`: Range of cells
- `A:A`: Entire column
- `1:5`: Entire rows

## Cell References

Cells are stored with their:
- **value**: The displayed value
- **formula**: The formula (if it starts with `=`)
- **formatted_value**: String representation
- **updated**: Last update timestamp

## Testing

Run the test suite:

```bash
pytest mcps/google_sheet/test_server.py -v
```

Tests cover:
- All 15 tools
- Database operations
- Cell updates and retrieval
- Formula handling
- Sheet management
- Batch operations
- Error handling

## Architecture

### Database Layer (`database_utils.py`)

The `GoogleSheetDatabase` class provides:
- Spreadsheet CRUD operations
- Sheet management
- Cell operations with A1 notation parsing
- Formula storage
- Batch operations
- Permission management

Key methods:
- `create_spreadsheet()`: Create new spreadsheets
- `create_sheet()`: Add sheets to spreadsheets
- `update_cells()`: Update cell values
- `get_values()`: Retrieve cell values as 2D arrays
- `get_formulas()`: Retrieve cell formulas
- `batch_update_cells()`: Update multiple ranges
- `copy_sheet()`: Copy sheets between spreadsheets
- `share_spreadsheet()`: Manage sharing

### Server Layer (`server.py`)

The `GoogleSheetMCPServer` class:
- Registers all 15 tools
- Handles MCP protocol communication
- Validates inputs
- Formats responses
- Manages database interactions

### Helper Functions

- `column_letter_to_index()`: Convert A, B, AA to indices
- `column_index_to_letter()`: Convert indices to column letters
- `parse_a1_notation()`: Parse A1 notation to cell coordinates

## Differences from Real Google Sheets API

1. **Offline Operation**: No internet connection required
2. **Simplified Authentication**: No OAuth or API keys needed
3. **Local Storage**: Data stored in JSON files
4. **Instant Operations**: No network latency
5. **Simplified Sharing**: Sharing is simulated without actual permissions
6. **No Formatting Details**: When `include_grid_data=False`, formatting is not included

## Common Use Cases

### Budget Tracking
```python
# Create budget spreadsheet
create_spreadsheet(title="Family Budget 2024")
create_sheet(spreadsheet_id=..., title="January")
update_cells(sheet="January", range="A1", data=[
    ["Category", "Budgeted", "Actual", "Difference"],
    ["Groceries", "500", "475", "=B2-C2"]
])
```

### Data Analysis
```python
# Import data and analyze
update_cells(sheet="Data", range="A1", data=raw_data)
get_sheet_data(sheet="Data", range="A1:Z100")
# Process with formulas
update_cells(sheet="Analysis", range="A1", data=[
    ["Total", "=SUM(Data!A:A)"],
    ["Average", "=AVERAGE(Data!A:A)"]
])
```

### Project Management
```python
# Create project tracker
create_spreadsheet(title="Project Tasks")
create_sheet(title="Sprint 1")
create_sheet(title="Sprint 2")
update_cells(sheet="Sprint 1", range="A1", data=[
    ["Task", "Assignee", "Status", "Priority"],
    ["Setup", "Alice", "Done", "High"]
])
```

## Error Handling

The server gracefully handles:
- Invalid spreadsheet IDs
- Non-existent sheets
- Invalid A1 notation
- Missing required parameters
- Invalid cell ranges

Errors are returned in a structured format with descriptive messages.

## Performance

- Fast local operations (no network calls)
- Efficient JSON storage
- In-memory caching for frequently accessed data
- Batch operations for multiple updates

## Limitations

1. No actual formula calculation (formulas are stored but not evaluated)
2. No cell formatting or styling
3. No charts or pivot tables
4. No real-time collaboration
5. No revision history
6. Simplified permission model

## Future Enhancements

Potential improvements:
- Formula evaluation engine
- Cell formatting support
- Data validation rules
- Conditional formatting
- Named ranges
- Protected ranges
- Import/export to Excel format

## Contributing

When adding new features:
1. Update `database_utils.py` with data operations
2. Add tool handler in `server.py`
3. Register tool with proper schema
4. Add tests in `test_server.py`
5. Update this README

## License

Part of the MCP Bench project. See main project LICENSE for details.

## Support

For issues or questions:
1. Check the test file for usage examples
2. Review the extracted data JSON for expected formats
3. Examine the database_utils.py for available operations

## Version History

- **1.0.0**: Initial release with all 15 tools
  - Full spreadsheet and sheet management
  - Cell data operations
  - Formula support
  - Batch operations
  - Sharing functionality
