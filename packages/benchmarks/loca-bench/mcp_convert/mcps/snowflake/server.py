#!/usr/bin/env python3
"""
Snowflake MCP Server

A Model Context Protocol (MCP) server implementation that provides database 
interaction with Snowflake. This server enables running SQL queries via tools 
and exposes data insights and schema context as resources.

This is a local implementation using SQLite to simulate Snowflake functionality 
for testing and development purposes.
"""

import asyncio
import sys
import os
import uuid
import json

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.mcp.server_base import BaseMCPServer
from common.mcp.tools import ToolRegistry
from mcps.snowflake.database_utils import SnowflakeDatabase


def to_yaml(data: dict, indent: int = 0) -> str:
    """Convert dictionary to YAML-like string format without external dependencies"""
    lines = []
    prefix = " " * indent
    
    for key, value in data.items():
        if value is None:
            lines.append(f"{prefix}{key}: null")
        elif isinstance(value, dict):
            lines.append(f"{prefix}{key}:")
            lines.append(to_yaml(value, indent + 2))
        elif isinstance(value, list):
            if not value:
                lines.append(f"{prefix}{key}: []")
            else:
                lines.append(f"{prefix}{key}:")
                for item in value:
                    if isinstance(item, dict):
                        lines.append(f"{prefix}- ")
                        for k, v in item.items():
                            if v is None:
                                lines.append(f"{prefix}  {k}: null")
                            else:
                                lines.append(f"{prefix}  {k}: {v}")
                    else:
                        lines.append(f"{prefix}- {item}")
        elif isinstance(value, str):
            # Escape special characters if needed
            if '\n' in value or ':' in value:
                lines.append(f"{prefix}{key}: '{value}'")
            else:
                lines.append(f"{prefix}{key}: {value}")
        else:
            lines.append(f"{prefix}{key}: {value}")
    
    return '\n'.join(lines)


class SnowflakeMCPServer(BaseMCPServer):
    """Snowflake MCP server implementation"""
    
    def __init__(self):
        super().__init__("snowflake", "1.0.0")
        
        # Get data directory from environment variable or use default
        data_dir = os.environ.get('SNOWFLAKE_DATA_DIR')
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if data_dir:
            if not quiet:
                print(f"Using Snowflake data directory from environment: {data_dir}", file=sys.stderr)
            os.makedirs(data_dir, exist_ok=True)
        else:
            # Use default data directory if not specified
            data_dir = os.path.join(os.path.dirname(__file__), "data")
            if not quiet:
                print(f"Using default Snowflake data directory: {data_dir}", file=sys.stderr)
        
        self.db = SnowflakeDatabase(data_dir=data_dir)
        self.tool_registry = ToolRegistry()
        self.setup_tools()
    
    def setup_tools(self):
        """Setup all Snowflake tools"""
        
        # ==================== Database Schema Tools ====================
        
        self.tool_registry.register(
            name="list_databases",
            description="List all available databases in Snowflake",
            input_schema={
                "type": "object",
                "properties": {}
            },
            handler=self.list_databases
        )
        
        self.tool_registry.register(
            name="list_schemas",
            description="List all schemas in a database",
            input_schema={
                "type": "object",
                "properties": {
                    "database": {
                        "type": "string",
                        "description": "Database name to list schemas from"
                    }
                },
                "required": ["database"]
            },
            handler=self.list_schemas
        )
        
        self.tool_registry.register(
            name="list_tables",
            description="List all tables in a specific database and schema",
            input_schema={
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Database name"},
                    "schema": {"type": "string", "description": "Schema name"}
                },
                "required": ["database", "schema"]
            },
            handler=self.list_tables
        )
        
        self.tool_registry.register(
            name="describe_table",
            description="Get the schema information for a specific table",
            input_schema={
                "type": "object",
                "properties": {
                    "table_name": {
                        "type": "string",
                        "description": "Fully qualified table name in the format 'database.schema.table'"
                    }
                },
                "required": ["table_name"]
            },
            handler=self.describe_table
        )
        
        # ==================== Query Tools ====================
        
        self.tool_registry.register(
            name="read_query",
            description="Execute a SELECT query.",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "SELECT SQL query to execute"}
                },
                "required": ["query"]
            },
            handler=self.read_query
        )
        
        self.tool_registry.register(
            name="write_query",
            description="Execute an INSERT, UPDATE, or DELETE query on the Snowflake database",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "SQL query to execute"}
                },
                "required": ["query"]
            },
            handler=self.write_query
        )
        
        self.tool_registry.register(
            name="create_table",
            description="Create a new table in the Snowflake database",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "CREATE TABLE SQL statement"}
                },
                "required": ["query"]
            },
            handler=self.create_table
        )
        
        # ==================== Resource Tools ====================
        
        self.tool_registry.register(
            name="append_insight",
            description="Add a data insight to the memo",
            input_schema={
                "type": "object",
                "properties": {
                    "insight": {
                        "type": "string",
                        "description": "Data insight discovered from analysis"
                    }
                },
                "required": ["insight"]
            },
            handler=self.append_insight
        )
    
    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()
    
    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        return await self.tool_registry.call_tool(name, arguments)
    
    # ==================== Tool Handlers ====================
    
    async def list_databases(self, args: dict):
        """List all available databases"""
        databases = self.db.list_databases()
        
        data_id = str(uuid.uuid4())
        output = {
            "type": "data",
            "data_id": data_id,
            "data": [{"DATABASE_NAME": db} for db in databases]
        }
        
        yaml_output = to_yaml(output)
        return self.create_text_response(yaml_output)
    
    async def list_schemas(self, args: dict):
        """List all schemas in a database"""
        database = args.get("database")
        if not database:
            return self.create_error_response("Missing required 'database' parameter")
        
        schemas = self.db.list_schemas(database)
        
        data_id = str(uuid.uuid4())
        output = {
            "type": "data",
            "data_id": data_id,
            "database": database,
            "data": [{"SCHEMA_NAME": schema} for schema in schemas]
        }
        
        yaml_output = to_yaml(output)
        return self.create_text_response(yaml_output)
    
    async def list_tables(self, args: dict):
        """List all tables in a specific database and schema"""
        database = args.get("database")
        schema = args.get("schema")
        
        if not database or not schema:
            return self.create_error_response("Missing required 'database' and 'schema' parameters")
        
        tables = self.db.list_tables(database, schema)
        
        data_id = str(uuid.uuid4())
        output = {
            "type": "data",
            "data_id": data_id,
            "database": database,
            "schema": schema,
            "data": tables
        }
        
        yaml_output = to_yaml(output)
        return self.create_text_response(yaml_output)
    
    async def describe_table(self, args: dict):
        """Get the schema information for a specific table"""
        table_name = args.get("table_name")
        if not table_name:
            return self.create_error_response("Missing table_name argument")
        
        # Parse the fully qualified table name
        parts = table_name.split(".")
        if len(parts) < 3:
            return self.create_error_response(
                "Table name must be fully qualified as 'database.schema.table'"
            )
        
        database = parts[0].upper()
        schema = parts[1].upper()
        table = parts[2].upper()
        
        columns = self.db.describe_table(database, schema, table)
        
        data_id = str(uuid.uuid4())
        output = {
            "type": "data",
            "data_id": data_id,
            "database": database,
            "schema": schema,
            "table": table,
            "data": columns
        }
        
        yaml_output = to_yaml(output)
        return self.create_text_response(yaml_output)
    
    async def read_query(self, args: dict):
        """Execute a SELECT query"""
        query = args.get("query")
        if not query:
            return self.create_error_response("Missing query argument")
        
        # Check if this is a SELECT query
        if not query.strip().upper().startswith("SELECT"):
            return self.create_error_response(
                "Calls to read_query should only contain SELECT operations"
            )
        
        try:
            results = self.db.execute_query(query)
            
            data_id = str(uuid.uuid4())
            output = {
                "type": "data",
                "data_id": data_id,
                "data": results
            }
            
            yaml_output = to_yaml(output)
            return self.create_text_response(yaml_output)
        except Exception as e:
            return self.create_error_response(f"Query execution failed: {str(e)}")
    
    async def write_query(self, args: dict):
        """Execute an INSERT, UPDATE, or DELETE query"""
        query = args.get("query")
        if not query:
            return self.create_error_response("Missing query argument")
        
        # Check that this is not a SELECT query
        if query.strip().upper().startswith("SELECT"):
            return self.create_error_response(
                "SELECT queries are not allowed for write_query"
            )
        
        try:
            affected_rows = self.db.execute_write_query(query)
            data_id = str(uuid.uuid4())
            
            return self.create_text_response(
                f"Query executed successfully. {affected_rows} rows affected. data_id = {data_id}"
            )
        except Exception as e:
            return self.create_error_response(f"Query execution failed: {str(e)}")
    
    async def create_table(self, args: dict):
        """Create a new table"""
        query = args.get("query")
        if not query:
            return self.create_error_response("Missing query argument")
        
        # Check that this is a CREATE TABLE statement
        if not query.strip().upper().startswith("CREATE TABLE"):
            return self.create_error_response(
                "Only CREATE TABLE statements are allowed"
            )
        
        try:
            self.db.execute_write_query(query)
            data_id = str(uuid.uuid4())
            
            return self.create_text_response(
                f"Table created successfully. data_id = {data_id}"
            )
        except Exception as e:
            return self.create_error_response(f"Table creation failed: {str(e)}")
    
    async def append_insight(self, args: dict):
        """Add a data insight to the memo"""
        insight = args.get("insight")
        if not insight:
            return self.create_error_response("Missing insight argument")
        
        self.db.add_insight(insight)
        return self.create_text_response("Insight added to memo")
    
    def create_error_response(self, error_message: str):
        """Create an error response"""
        return self.create_text_response(f"Error: {error_message}")


async def main():
    """Main entry point"""
    server = SnowflakeMCPServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
