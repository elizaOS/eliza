#!/usr/bin/env python3
"""
Initialize Snowflake database from extracted data

This script extracts schema and data from snowflake_extracted_data.json
and initializes the local SQLite database to match the structure.
"""

import json
import os
import sys
import re
from typing import Dict, List, Any

# Add current directory to path to import database_utils
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from database_utils import SnowflakeDatabase


def extract_schema_from_describe(data: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Extract column schema from describe_table result"""
    columns = []
    for col in data:
        columns.append({
            "name": col.get("COLUMN_NAME", ""),
            "type": col.get("DATA_TYPE", "TEXT"),
            "default": col.get("COLUMN_DEFAULT"),
            "nullable": col.get("IS_NULLABLE", "YES"),
            "comment": col.get("COMMENT")
        })
    return columns


def extract_data_from_read_query(data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Extract data rows from read_query result"""
    return data


def parse_yaml_data(yaml_text: str) -> Dict[str, Any]:
    """Parse YAML-formatted data from tool results"""
    result = {
        "type": None,
        "data_id": None,
        "database": None,
        "schema": None,
        "table": None,
        "data": []
    }
    
    lines = yaml_text.strip().split('\n')
    current_key = None
    data_list = []
    current_item = {}
    
    for line in lines:
        line = line.rstrip()
        
        # Check for key-value pairs
        if ':' in line and not line.startswith(' ') and not line.startswith('-'):
            key, value = line.split(':', 1)
            key = key.strip()
            value = value.strip()
            
            if key == 'data':
                current_key = 'data'
                if value:  # Single-line data value
                    result['data'] = value
            else:
                if value and value != 'null':
                    result[key] = value
                else:
                    result[key] = None
        
        # Check for list items
        elif line.startswith('- '):
            if current_item:
                data_list.append(current_item)
            current_item = {}
            
            # Parse item on same line
            item_text = line[2:].strip()
            if ':' in item_text:
                key, value = item_text.split(':', 1)
                key = key.strip()
                value = value.strip()
                if value == 'null' or value == '':
                    current_item[key] = None
                elif value.startswith("'") and value.endswith("'"):
                    current_item[key] = value[1:-1]
                else:
                    # Try to convert to number
                    try:
                        if '.' in value:
                            current_item[key] = float(value)
                        else:
                            current_item[key] = int(value)
                    except ValueError:
                        current_item[key] = value
        
        # Check for continuation of list item
        elif line.startswith('  ') and current_item is not None:
            item_text = line.strip()
            if ':' in item_text:
                key, value = item_text.split(':', 1)
                key = key.strip()
                value = value.strip()
                if value == 'null' or value == '':
                    current_item[key] = None
                elif value.startswith("'") and value.endswith("'"):
                    current_item[key] = value[1:-1]
                else:
                    # Try to convert to number
                    try:
                        if '.' in value:
                            current_item[key] = float(value)
                        else:
                            current_item[key] = int(value)
                    except ValueError:
                        current_item[key] = value
    
    # Add last item
    if current_item:
        data_list.append(current_item)
    
    if data_list:
        result['data'] = data_list
    
    return result


def init_database_from_extracted_data(extracted_data_path: str, data_dir: str = None):
    """Initialize database from extracted data JSON file"""
    
    # Load extracted data
    print(f"Loading extracted data from {extracted_data_path}...")
    with open(extracted_data_path, 'r') as f:
        extracted_data = json.load(f)
    
    print(f"Found {len(extracted_data)} tool call examples")
    
    # Initialize database
    db = SnowflakeDatabase(data_dir=data_dir)
    
    # Track discovered tables and their schemas
    tables_discovered = {}  # (database, schema, table) -> columns
    table_data = {}  # (database, schema, table) -> data rows
    
    # Process each tool call example
    for idx, example in enumerate(extracted_data):
        if 'tool_calls' not in example or 'tool_result' not in example:
            continue
        
        tool_call = example['tool_calls'][0] if example['tool_calls'] else None
        if not tool_call:
            continue
        
        tool_name = tool_call['function']['name']
        tool_args = tool_call['function']['arguments']
        tool_result = example['tool_result']['content']
        
        # Remove "snowflake-" prefix if present
        if tool_name.startswith('snowflake-'):
            tool_name = tool_name[10:]
        
        result_text = tool_result.get('text', '') if isinstance(tool_result, dict) else tool_result
        
        # Parse the YAML result
        parsed = parse_yaml_data(result_text)
        
        # Handle different tool types
        if tool_name == 'describe_table':
            table_name = tool_args.get('table_name', '')
            if '.' in table_name:
                parts = table_name.split('.')
                if len(parts) == 3:
                    database, schema, table = [p.upper() for p in parts]
                    
                    # Extract column schema
                    columns = extract_schema_from_describe(parsed['data'])
                    
                    key = (database, schema, table)
                    tables_discovered[key] = columns
                    
                    print(f"Discovered table: {database}.{schema}.{table} with {len(columns)} columns")
        
        elif tool_name == 'read_query':
            query = tool_args.get('query', '')
            
            # Try to extract table name from query
            # Pattern: FROM database.schema.table
            match = re.search(r'FROM\s+([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)', query, re.IGNORECASE)
            if match:
                table_name = match.group(1)
                parts = table_name.split('.')
                if len(parts) == 3:
                    database, schema, table = [p.upper() for p in parts]
                    key = (database, schema, table)
                    
                    # Extract data if we have the schema
                    if key in tables_discovered and parsed['data']:
                        if key not in table_data:
                            table_data[key] = []
                        
                        data_rows = parsed['data']
                        if isinstance(data_rows, list):
                            # Merge with existing data (avoid duplicates)
                            existing_keys = set()
                            if table_data[key]:
                                # Use first column as key for deduplication
                                first_col = list(table_data[key][0].keys())[0] if table_data[key] else None
                                if first_col:
                                    existing_keys = {row.get(first_col) for row in table_data[key]}
                            
                            for row in data_rows:
                                if not existing_keys or (row.get(first_col) not in existing_keys if first_col else True):
                                    table_data[key].append(row)
                            
                            print(f"Added {len(data_rows)} rows to {database}.{schema}.{table} (total: {len(table_data[key])})")
    
    print(f"\nDiscovered {len(tables_discovered)} unique tables")
    print(f"Collected data for {len(table_data)} tables")
    
    # Import tables into database
    print("\nImporting tables into database...")
    for key, columns in tables_discovered.items():
        database, schema, table = key
        data_rows = table_data.get(key, [])
        
        print(f"Importing {database}.{schema}.{table} with {len(data_rows)} rows...")
        try:
            db.import_table_data(database, schema, table, columns, data_rows)
        except Exception as e:
            print(f"    Error importing table: {e}")
            continue
    
    print("\nDatabase initialization complete!")
    
    # Print summary
    print("\nSummary:")
    print(f"  Databases: {len(db.list_databases())}")
    for database in db.list_databases():
        schemas = db.list_schemas(database)
        print(f"    {database}: {len(schemas)} schemas")
        for schema in schemas:
            tables = db.list_tables(database, schema)
            print(f"      {schema}: {len(tables)} tables")


def main():
    """Main entry point"""
    # Get paths from command line or use defaults
    if len(sys.argv) > 1:
        extracted_data_path = sys.argv[1]
    else:
        # Default path
        extracted_data_path = ""
    
    if len(sys.argv) > 2:
        data_dir = sys.argv[2]
    else:
        # Default data directory
        data_dir = os.path.join(os.path.dirname(__file__), "data")
    
    if not os.path.exists(extracted_data_path):
        print(f"Error: Extracted data file not found: {extracted_data_path}")
        print("Usage: python init_database.py [extracted_data.json] [data_dir]")
        sys.exit(1)
    
    print(f"Extracted data path: {extracted_data_path}")
    print(f"Data directory: {data_dir}")
    print()
    
    init_database_from_extracted_data(extracted_data_path, data_dir)


if __name__ == "__main__":
    main()

