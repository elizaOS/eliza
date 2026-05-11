# Snowflake MCP Server

A Model Context Protocol (MCP) server implementation that provides database interaction with Snowflake. This is a **local implementation** using SQLite to simulate Snowflake functionality for testing and development purposes.

## Features

This server enables running SQL queries via tools and exposes data insights and schema context as resources. It fully replicates the functionality of the original `mcp-snowflake-server` with the following tools:

### Available Tools

1. **list_databases** - List all available databases in Snowflake
2. **list_schemas** - List all schemas in a database
3. **list_tables** - List all tables in a specific database and schema
4. **describe_table** - Get the schema information for a specific table
5. **read_query** - Execute a SELECT query
6. **write_query** - Execute an INSERT, UPDATE, or DELETE query
7. **create_table** - Create a new table in the Snowflake database
8. **append_insight** - Add a data insight to the memo

## Installation

### Prerequisites

- Python 3.8+
- No external dependencies (uses only standard library)

### Setup

1. Navigate to the snowflake directory:
```bash
cd /path/to/mcp-convert/mcps/snowflake
```

2. Initialize the database with sample data:
```bash
python init_database.py /path/to/snowflake_extracted_data.json
```

This will create a local SQLite database in the `data/` directory with the Snowflake schema and data extracted from the real server.

## Usage

### Running the Server

```bash
python server.py
```

The server will start and listen for MCP protocol messages on stdin/stdout.

### Testing

Run the test suite to verify all tools are working:

```bash
python test_server.py
```

This will test all 8 tools and display the results.

### Example Tool Calls

#### List Databases
```json
{
  "tool": "list_databases",
  "arguments": {}
}
```

#### List Schemas
```json
{
  "tool": "list_schemas",
  "arguments": {
    "database": "PURCHASE_INVOICE"
  }
}
```

#### List Tables
```json
{
  "tool": "list_tables",
  "arguments": {
    "database": "PURCHASE_INVOICE",
    "schema": "PUBLIC"
  }
}
```

#### Describe Table
```json
{
  "tool": "describe_table",
  "arguments": {
    "table_name": "PURCHASE_INVOICE.PUBLIC.INVOICES"
  }
}
```

#### Read Query
```json
{
  "tool": "read_query",
  "arguments": {
    "query": "SELECT * FROM PURCHASE_INVOICE.PUBLIC.INVOICES LIMIT 10"
  }
}
```

#### Write Query
```json
{
  "tool": "write_query",
  "arguments": {
    "query": "INSERT INTO PURCHASE_INVOICE.PUBLIC.INVOICES (INVOICE_ID, PURCHASER_EMAIL, SUPPLIER_NAME, INVOICE_AMOUNT) VALUES ('INV-001', 'test@example.com', 'Test Supplier', 1000)"
  }
}
```

#### Create Table
```json
{
  "tool": "create_table",
  "arguments": {
    "query": "CREATE TABLE PURCHASE_INVOICE.PUBLIC.MY_TABLE (ID NUMBER NOT NULL, NAME TEXT, VALUE NUMBER)"
  }
}
```

#### Append Insight
```json
{
  "tool": "append_insight",
  "arguments": {
    "insight": "The average invoice amount is $50,000"
  }
}
```

## Architecture

### Components

- **server.py** - Main MCP server implementation
- **database_utils.py** - Database operations using SQLite to simulate Snowflake
- **init_database.py** - Script to initialize the database from extracted data
- **test_server.py** - Test suite for all tools

### Database Structure

The local SQLite database simulates Snowflake's three-level hierarchy:

1. **Databases** - Top-level containers (e.g., PURCHASE_INVOICE, SLA_MONITOR)
2. **Schemas** - Second-level containers within databases (e.g., PUBLIC, INFORMATION_SCHEMA)
3. **Tables** - Data tables within schemas

Table names in SQLite are stored as `{DATABASE}_{SCHEMA}_{TABLE}` (e.g., `PURCHASE_INVOICE_PUBLIC_INVOICES`).

### Metadata Storage

- **metadata.json** - Stores the database/schema/table hierarchy
- **insights.json** - Stores data insights added via `append_insight`
- **snowflake.db** - SQLite database containing all table data

## Alignment with Original Server

This implementation is designed to be fully compatible with the original `mcp-snowflake-server`. All tools have:

- **Identical names** - Tool names match exactly (e.g., `list_databases`, `read_query`)
- **Identical parameters** - Input schemas are the same
- **Identical output format** - Responses use the same YAML format with `data_id`, `type`, and `data` fields
- **Identical behavior** - Query translation, error handling, and validation match the original

## Sample Data

The initialized database includes data from several databases:

- **PURCHASE_INVOICE** - Invoice and payment data
  - INVOICES table (5 columns)
  - INVOICE_PAYMENTS table (1015 rows, 3 columns)

- **SLA_MONITOR** - Support ticket tracking
  - SUPPORT_TICKETS table (12 columns, 6 rows)
  - USERS table (7 columns)

- **LANDING_TASK_REMINDER** - Task management
  - EMPLOYEE table (26 rows, 4 columns)
  - EMPLOYEE_LANDING table (26 rows, 3 columns)
  - PUBLIC_TASKS table (95 rows, 5 columns)
  - GROUP_TASKS_* tables (various)

- **TRAVEL_EXPENSE_REIMBURSEMENT** - Expense tracking
  - ENTERPRISE_CONTACTS table (12 columns)
  - 2024Q4REIMBURSEMENT table (12 columns)

## Environment Variables

- **SNOWFLAKE_DATA_DIR** - Optional. Specify a custom data directory for the database files. If not set, defaults to `./data`.

Example:
```bash
export SNOWFLAKE_DATA_DIR=/custom/path/to/data
python server.py
```

## Limitations

This is a local simulation and has some differences from the real Snowflake:

1. **Data Types** - All numbers stored as REAL, dates as TEXT
2. **Functions** - SQL functions like `CURRENT_TIMESTAMP()` are not supported in defaults
3. **Performance** - SQLite performance differs from Snowflake
4. **Features** - Some advanced Snowflake features are not implemented

## Development

### Adding New Tables

To add new tables, either:

1. Use the `create_table` tool
2. Manually add data via `database_utils.py`'s `import_table_data()` method

### Extending Functionality

The server uses a modular design. To add new tools:

1. Define the tool in `server.py`'s `setup_tools()` method
2. Implement the handler method
3. Add database operations in `database_utils.py` if needed

## License

This implementation follows the same license as the original mcp-snowflake-server project.

## References

- Original Server: https://github.com/modelcontextprotocol/servers/tree/main/src/snowflake
- MCP Protocol: https://modelcontextprotocol.io
