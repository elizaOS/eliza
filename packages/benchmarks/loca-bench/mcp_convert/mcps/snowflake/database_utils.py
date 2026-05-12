"""
Database utilities for Snowflake MCP Server

Handles data operations for the Snowflake implementation using SQLite 
to simulate Snowflake's database/schema/table hierarchy.
"""

import os
import sys
import sqlite3
import json
import re
from typing import Dict, List, Any, Optional, Tuple


class SimpleJsonDatabase:
    """Simple JSON database handler without external dependencies"""
    
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
    
    def load_data(self, filename: str) -> Any:
        """Load data from JSON file"""
        filepath = os.path.join(self.data_dir, filename)
        if not os.path.exists(filepath):
            return None
        try:
            with open(filepath, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return None
    
    def save_data(self, filename: str, data: Any) -> bool:
        """Save data to JSON file"""
        filepath = os.path.join(self.data_dir, filename)
        try:
            with open(filepath, 'w') as f:
                json.dump(data, f, indent=2)
            return True
        except IOError:
            return False
    
    def file_exists(self, filename: str) -> bool:
        """Check if file exists"""
        filepath = os.path.join(self.data_dir, filename)
        return os.path.exists(filepath)


class SnowflakeDatabase:
    """Database handler for Snowflake data using SQLite as backend"""
    
    def __init__(self, data_dir: str = None):
        """Initialize database with data directory"""
        if data_dir is None:
            # Default to data directory in the same folder as this file
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        
        # Initialize SQLite database
        self.db_path = os.path.join(data_dir, "snowflake.db")
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row  # Return rows as dictionaries
        
        # Initialize JSON database for metadata
        self.json_db = SimpleJsonDatabase(data_dir)
        self.metadata_file = "metadata.json"
        self.insights_file = "insights.json"
        
        # Initialize metadata storage
        self._init_metadata()
        
        # Initialize insights storage
        if not self.json_db.file_exists(self.insights_file):
            self.json_db.save_data(self.insights_file, [])
    
    def _init_metadata(self):
        """Initialize metadata tables"""
        # Create metadata table to track databases, schemas, and tables
        cursor = self.conn.cursor()
        
        # Create metadata table if not exists
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS _metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        
        # Create table to track schema structure
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS _table_metadata (
                database TEXT,
                schema TEXT,
                table_name TEXT,
                column_name TEXT,
                column_default TEXT,
                is_nullable TEXT,
                data_type TEXT,
                comment TEXT,
                PRIMARY KEY (database, schema, table_name, column_name)
            )
        """)
        
        self.conn.commit()
        
        # Load or initialize metadata
        metadata = self.json_db.load_data(self.metadata_file)
        if not metadata:
            metadata = {
                "databases": {},
                "version": "1.0.0"
            }
            self.json_db.save_data(self.metadata_file, metadata)
    
    def _get_metadata(self) -> dict:
        """Get current metadata"""
        return self.json_db.load_data(self.metadata_file)
    
    def _save_metadata(self, metadata: dict):
        """Save metadata"""
        self.json_db.save_data(self.metadata_file, metadata)
    
    def _register_database(self, database_name: str):
        """Register a new database"""
        metadata = self._get_metadata()
        database_name = database_name.upper()
        
        if database_name not in metadata["databases"]:
            metadata["databases"][database_name] = {
                "schemas": {}
            }
            self._save_metadata(metadata)
    
    def _register_schema(self, database_name: str, schema_name: str):
        """Register a new schema"""
        database_name = database_name.upper()
        schema_name = schema_name.upper()
        
        self._register_database(database_name)
        
        metadata = self._get_metadata()
        if schema_name not in metadata["databases"][database_name]["schemas"]:
            metadata["databases"][database_name]["schemas"][schema_name] = {
                "tables": []
            }
            self._save_metadata(metadata)
    
    def _register_table(self, database_name: str, schema_name: str, table_name: str):
        """Register a new table"""
        database_name = database_name.upper()
        schema_name = schema_name.upper()
        table_name = table_name.upper()
        
        self._register_schema(database_name, schema_name)
        
        metadata = self._get_metadata()
        tables = metadata["databases"][database_name]["schemas"][schema_name]["tables"]
        
        if table_name not in tables:
            tables.append(table_name)
            self._save_metadata(metadata)
    
    def _get_physical_table_name(self, database: str, schema: str, table: str) -> str:
        """Get the physical SQLite table name"""
        return f"{database}_{schema}_{table}".upper()
    
    def list_databases(self) -> List[str]:
        """List all databases"""
        metadata = self._get_metadata()
        return sorted(metadata["databases"].keys())
    
    def list_schemas(self, database: str) -> List[str]:
        """List all schemas in a database"""
        database = database.upper()
        metadata = self._get_metadata()
        
        if database not in metadata["databases"]:
            return []
        
        return sorted(metadata["databases"][database]["schemas"].keys())
    
    def list_tables(self, database: str, schema: str) -> List[Dict[str, Any]]:
        """List all tables in a specific database and schema"""
        database = database.upper()
        schema = schema.upper()
        
        metadata = self._get_metadata()
        
        if database not in metadata["databases"]:
            return []
        
        if schema not in metadata["databases"][database]["schemas"]:
            return []
        
        tables = metadata["databases"][database]["schemas"][schema]["tables"]
        
        # Format output to match Snowflake's INFORMATION_SCHEMA.TABLES
        result = []
        for table_name in tables:
            result.append({
                "TABLE_CATALOG": database,
                "TABLE_SCHEMA": schema,
                "TABLE_NAME": table_name,
                "COMMENT": None
            })
        
        return result
    
    def describe_table(self, database: str, schema: str, table: str) -> List[Dict[str, Any]]:
        """Get the schema information for a specific table"""
        database = database.upper()
        schema = schema.upper()
        table = table.upper()
        
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT column_name, column_default, is_nullable, data_type, comment
            FROM _table_metadata
            WHERE database = ? AND schema = ? AND table_name = ?
            ORDER BY column_name
        """, (database, schema, table))
        
        columns = []
        for row in cursor.fetchall():
            columns.append({
                "COLUMN_NAME": row["column_name"],
                "COLUMN_DEFAULT": row["column_default"],
                "IS_NULLABLE": row["is_nullable"],
                "DATA_TYPE": row["data_type"],
                "COMMENT": row["comment"]
            })
        
        return columns
    
    def execute_query(self, query: str) -> List[Dict[str, Any]]:
        """Execute a SELECT query and return results"""
        # Translate Snowflake-style fully qualified names to SQLite table names
        translated_query = self._translate_query(query)
        
        cursor = self.conn.cursor()
        cursor.execute(translated_query)
        
        # Convert rows to list of dictionaries
        columns = [description[0] for description in cursor.description]
        results = []
        
        for row in cursor.fetchall():
            result_dict = {}
            for idx, col_name in enumerate(columns):
                result_dict[col_name.upper()] = row[idx]
            results.append(result_dict)
        
        return results
    
    def execute_write_query(self, query: str) -> int:
        """Execute an INSERT, UPDATE, DELETE, or CREATE query"""
        # Handle CREATE TABLE specially
        if query.strip().upper().startswith("CREATE TABLE"):
            self._handle_create_table(query)
            return 0
        
        # Translate and execute other write queries
        translated_query = self._translate_query(query)
        
        cursor = self.conn.cursor()
        cursor.execute(translated_query)
        self.conn.commit()
        
        return cursor.rowcount
    
    def _handle_create_table(self, query: str):
        """Handle CREATE TABLE statement"""
        # Parse the CREATE TABLE statement
        # Extract database.schema.table and column definitions
        
        # Simple regex to extract table name and columns
        # Format: CREATE TABLE database.schema.table (column definitions)
        match = re.search(r'CREATE\s+TABLE\s+([^\s(]+)\s*\((.*)\)', query, re.IGNORECASE | re.DOTALL)
        
        if not match:
            raise ValueError("Invalid CREATE TABLE syntax")
        
        full_table_name = match.group(1)
        column_defs = match.group(2)
        
        # Parse fully qualified table name
        parts = full_table_name.split('.')
        if len(parts) != 3:
            raise ValueError("Table name must be fully qualified as 'database.schema.table'")
        
        database, schema, table = [p.strip().strip('"').upper() for p in parts]
        
        # Register the table in metadata
        self._register_table(database, schema, table)
        
        # Parse column definitions
        columns = self._parse_column_definitions(column_defs)
        
        # Store column metadata
        cursor = self.conn.cursor()
        for col in columns:
            cursor.execute("""
                INSERT OR REPLACE INTO _table_metadata 
                (database, schema, table_name, column_name, column_default, is_nullable, data_type, comment)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                database, schema, table,
                col["name"], col["default"], col["nullable"],
                col["type"], col["comment"]
            ))
        
        # Create the actual SQLite table
        physical_table_name = self._get_physical_table_name(database, schema, table)
        
        # Build SQLite CREATE TABLE statement
        sqlite_columns = []
        for col in columns:
            col_def = f'"{col["name"]}" {self._map_snowflake_type_to_sqlite(col["type"])}'
            if col["default"]:
                col_def += f' DEFAULT {col["default"]}'
            if col["nullable"] == "NO":
                col_def += " NOT NULL"
            sqlite_columns.append(col_def)
        
        create_stmt = f'CREATE TABLE IF NOT EXISTS "{physical_table_name}" ({", ".join(sqlite_columns)})'
        cursor.execute(create_stmt)
        
        self.conn.commit()
    
    def _parse_column_definitions(self, column_defs: str) -> List[Dict[str, str]]:
        """Parse column definitions from CREATE TABLE statement"""
        columns = []
        
        # Split by comma (but not commas inside parentheses or quotes)
        col_defs = []
        current_col = ""
        paren_depth = 0
        in_quote = False
        quote_char = None
        
        for i, char in enumerate(column_defs):
            # Handle quotes
            if char in ('"', "'") and (i == 0 or column_defs[i-1] != '\\'):
                if not in_quote:
                    in_quote = True
                    quote_char = char
                elif char == quote_char:
                    in_quote = False
                    quote_char = None
            
            # Handle parentheses (only count if not in quotes)
            if not in_quote:
                if char == '(':
                    paren_depth += 1
                elif char == ')':
                    paren_depth -= 1
                elif char == ',' and paren_depth == 0:
                    col_defs.append(current_col.strip())
                    current_col = ""
                    continue
            
            current_col += char
        
        if current_col.strip():
            col_defs.append(current_col.strip())
        
        # Parse each column definition
        for col_def in col_defs:
            col_def = col_def.strip()
            if not col_def:
                continue
            
            # Extract column name and type
            parts = col_def.split()
            if len(parts) < 2:
                continue
            
            col_name = parts[0].strip('"').upper()
            col_type = parts[1].upper()
            
            # Check for modifiers
            col_default = None
            col_nullable = "YES"
            col_comment = None
            
            col_def_upper = col_def.upper()
            
            if "NOT NULL" in col_def_upper:
                col_nullable = "NO"
            
            # Extract DEFAULT value
            default_match = re.search(r'DEFAULT\s+([^\s,]+)', col_def, re.IGNORECASE)
            if default_match:
                col_default = default_match.group(1).strip("'\"")
            
            # Extract COMMENT
            comment_match = re.search(r'COMMENT\s+["\']([^"\']+)["\']', col_def, re.IGNORECASE)
            if comment_match:
                col_comment = comment_match.group(1)
            
            columns.append({
                "name": col_name,
                "type": col_type,
                "default": col_default,
                "nullable": col_nullable,
                "comment": col_comment
            })
        
        return columns
    
    def _map_snowflake_type_to_sqlite(self, snowflake_type: str) -> str:
        """Map Snowflake data type to SQLite type"""
        snowflake_type = snowflake_type.upper()
        
        # Remove size specifications (e.g., VARCHAR(100) -> VARCHAR)
        base_type = snowflake_type.split('(')[0].strip()
        
        if base_type in ["NUMBER", "INT", "INTEGER", "BIGINT", "SMALLINT"]:
            return "REAL"  # SQLite uses REAL for numbers
        elif base_type in ["FLOAT", "DOUBLE", "REAL"]:
            return "REAL"
        elif base_type in ["VARCHAR", "STRING", "TEXT", "CHAR"]:
            return "TEXT"
        elif base_type == "DATE":
            return "TEXT"  # Store dates as text in SQLite
        elif base_type == "TIMESTAMP":
            return "TEXT"
        elif base_type == "BOOLEAN":
            return "INTEGER"  # 0 or 1
        else:
            return "TEXT"  # Default to TEXT for unknown types
    
    def _translate_query(self, query: str) -> str:
        """Translate Snowflake-style query to SQLite"""
        # Find all fully qualified table names (database.schema.table)
        # and replace them with physical table names
        
        # Pattern to match database.schema.table
        pattern = r'\b([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b'
        
        def replace_table_name(match):
            full_name = match.group(1)
            parts = full_name.split('.')
            if len(parts) == 3:
                database, schema, table = [p.upper() for p in parts]
                return f'"{self._get_physical_table_name(database, schema, table)}"'
            return full_name
        
        translated = re.sub(pattern, replace_table_name, query)
        return translated
    
    def add_insight(self, insight: str):
        """Add a data insight to the memo"""
        insights = self.json_db.load_data(self.insights_file)
        if not isinstance(insights, list):
            insights = []
        
        insights.append({
            "insight": insight,
            "timestamp": self._get_timestamp()
        })
        
        self.json_db.save_data(self.insights_file, insights)
    
    def get_insights(self) -> List[Dict[str, Any]]:
        """Get all data insights"""
        insights = self.json_db.load_data(self.insights_file)
        return insights if isinstance(insights, list) else []
    
    def _get_timestamp(self) -> str:
        """Get current timestamp as string"""
        from datetime import datetime
        return datetime.utcnow().isoformat() + "Z"
    
    def close(self):
        """Close database connections"""
        if self.conn:
            self.conn.close()
    
    def __del__(self):
        """Cleanup on deletion"""
        self.close()
    
    # ==================== Helper Methods for Data Import ====================
    
    def import_table_data(self, database: str, schema: str, table: str, 
                          columns: List[Dict[str, str]], data: List[Dict[str, Any]]):
        """Import data into a table (used for initialization)"""
        database = database.upper()
        schema = schema.upper()
        table = table.upper()
        
        # Register the table
        self._register_table(database, schema, table)
        
        # Store column metadata
        cursor = self.conn.cursor()
        for col in columns:
            cursor.execute("""
                INSERT OR REPLACE INTO _table_metadata 
                (database, schema, table_name, column_name, column_default, is_nullable, data_type, comment)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                database, schema, table,
                col["name"], col.get("default"), col.get("nullable", "YES"),
                col["type"], col.get("comment")
            ))
        
        # Create the actual SQLite table
        physical_table_name = self._get_physical_table_name(database, schema, table)
        
        # Build SQLite CREATE TABLE statement
        sqlite_columns = []
        for col in columns:
            sqlite_type = self._map_snowflake_type_to_sqlite(col["type"])
            col_def = f'"{col["name"]}" {sqlite_type}'
            
            # Handle default values carefully
            if col.get("default"):
                default_val = str(col["default"])
                
                # Skip complex default values like CURRENT_TIMESTAMP()
                if "(" in default_val and ")" in default_val:
                    # Skip function-based defaults
                    pass
                elif default_val.replace(".", "").replace("-", "").isdigit():
                    # Numeric default
                    col_def += f' DEFAULT {default_val}'
                else:
                    # String default - ensure proper quoting
                    # Remove any existing quotes
                    default_val = default_val.strip("'").strip('"')
                    col_def += f" DEFAULT '{default_val}'"
            
            if col.get("nullable") == "NO":
                col_def += " NOT NULL"
            sqlite_columns.append(col_def)
        
        # Drop table if exists and recreate
        cursor.execute(f'DROP TABLE IF EXISTS "{physical_table_name}"')
        create_stmt = f'CREATE TABLE "{physical_table_name}" ({", ".join(sqlite_columns)})'
        
        try:
            cursor.execute(create_stmt)
        except sqlite3.OperationalError as e:
            print(f"    Error creating table: {e}")
            print(f"    SQL: {create_stmt}")
            raise
        
        # Insert data
        if data:
            col_names = [col["name"] for col in columns]
            placeholders = ",".join(["?" for _ in col_names])
            quoted_col_names = ",".join([f'"{c}"' for c in col_names])
            insert_stmt = f'INSERT INTO "{physical_table_name}" ({quoted_col_names}) VALUES ({placeholders})'
            
            inserted_count = 0
            skipped_count = 0
            
            for row in data:
                values = []
                skip_row = False
                
                # Check if row has all required (NOT NULL) columns with non-null values
                for col in columns:
                    col_name = col["name"]
                    value = row.get(col_name.upper())
                    
                    # If column is NOT NULL and value is None, skip this row
                    if col.get("nullable") == "NO" and value is None:
                        skip_row = True
                        break
                    
                    values.append(value)
                
                if skip_row:
                    skipped_count += 1
                    continue
                
                try:
                    cursor.execute(insert_stmt, values)
                    inserted_count += 1
                except sqlite3.IntegrityError as e:
                    # Skip rows that violate constraints
                    skipped_count += 1
                    continue
            
            if skipped_count > 0:
                print(f"    Inserted {inserted_count} rows, skipped {skipped_count} rows due to constraint violations")
        
        self.conn.commit()
