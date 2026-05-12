"""
SQLite backend for Google Cloud MCP Server

Provides real SQL database operations using SQLite as the storage engine
"""

import sqlite3
import json
import os
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime, timezone


class SQLiteBackend:
    """SQLite backend for real SQL operations"""
    
    def __init__(self, db_path: str):
        """Initialize SQLite backend"""
        self.db_path = db_path
        self.conn = None
        self._connect()
    
    def _connect(self):
        """Connect to SQLite database"""
        os.makedirs(os.path.dirname(self.db_path) if os.path.dirname(self.db_path) else '.', exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row  # Return rows as dictionaries
        # Enable JSON support
        self.conn.execute("PRAGMA journal_mode=WAL")
    
    def _get_sqlite_type(self, bigquery_type: str) -> str:
        """Convert BigQuery type to SQLite type"""
        type_mapping = {
            'STRING': 'TEXT',
            'INTEGER': 'INTEGER',
            'INT64': 'INTEGER',
            'FLOAT': 'REAL',
            'FLOAT64': 'REAL',
            'NUMERIC': 'REAL',
            'BOOLEAN': 'INTEGER',
            'BOOL': 'INTEGER',
            'TIMESTAMP': 'TEXT',
            'DATETIME': 'TEXT',
            'DATE': 'TEXT',
            'TIME': 'TEXT',
            'JSON': 'TEXT',
            'BYTES': 'BLOB'
        }
        return type_mapping.get(bigquery_type.upper(), 'TEXT')
    
    def _get_table_name(self, project_id: str, dataset_id: str, table_id: str) -> str:
        """Get SQLite table name from BigQuery identifiers"""
        # Use double quotes for case sensitivity and special chars
        return f'"{project_id}_{dataset_id}_{table_id}"'
    
    def create_table_from_schema(self, project_id: str, dataset_id: str, table_id: str, 
                                  schema: List[Dict[str, str]]) -> bool:
        """Create a SQLite table based on BigQuery schema"""
        try:
            table_name = self._get_table_name(project_id, dataset_id, table_id)
            
            # Build CREATE TABLE statement
            columns = []
            for field in schema:
                field_name = field['name']
                field_type = self._get_sqlite_type(field['type'])
                field_mode = field.get('mode', 'NULLABLE')
                
                column_def = f'"{field_name}" {field_type}'
                if field_mode == 'REQUIRED':
                    column_def += ' NOT NULL'
                
                columns.append(column_def)
            
            create_sql = f"CREATE TABLE IF NOT EXISTS {table_name} ({', '.join(columns)})"
            
            self.conn.execute(create_sql)
            self.conn.commit()
            return True
        except Exception as e:
            print(f"Error creating table: {e}")
            return False
    
    def table_exists(self, project_id: str, dataset_id: str, table_id: str) -> bool:
        """Check if a table exists"""
        table_name = f"{project_id}_{dataset_id}_{table_id}"
        cursor = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,)
        )
        return cursor.fetchone() is not None
    
    def _clean_column_name(self, col_name: str) -> str:
        """Clean column name by removing BOM and other special characters"""
        # Remove BOM (Byte Order Mark) characters
        col_name = col_name.replace('\ufeff', '')
        col_name = col_name.replace('\ufffe', '')
        col_name = col_name.replace('\u200b', '')  # Zero-width space
        return col_name.strip()
    
    def insert_rows(self, project_id: str, dataset_id: str, table_id: str, 
                   rows: List[Dict[str, Any]], schema: List[Dict[str, str]]) -> int:
        """Insert rows into a table"""
        if not rows:
            return 0
        
        try:
            # Clean column names in schema
            cleaned_schema = []
            for field in schema:
                cleaned_field = field.copy()
                cleaned_field['name'] = self._clean_column_name(field['name'])
                cleaned_schema.append(cleaned_field)
            
            # Ensure table exists
            if not self.table_exists(project_id, dataset_id, table_id):
                self.create_table_from_schema(project_id, dataset_id, table_id, cleaned_schema)
            
            table_name = self._get_table_name(project_id, dataset_id, table_id)
            
            # Clean column names in rows
            cleaned_rows = []
            for row in rows:
                cleaned_row = {}
                for key, value in row.items():
                    cleaned_key = self._clean_column_name(key)
                    cleaned_row[cleaned_key] = value
                cleaned_rows.append(cleaned_row)
            
            # Get column names from first cleaned row
            columns = list(cleaned_rows[0].keys())
            placeholders = ','.join(['?' for _ in columns])
            column_names = ','.join([f'"{col}"' for col in columns])
            
            insert_sql = f"INSERT INTO {table_name} ({column_names}) VALUES ({placeholders})"
            
            # Convert JSON fields to strings
            processed_rows = []
            for row in cleaned_rows:
                processed_row = []
                for col in columns:
                    value = row[col]
                    # Convert dict/list to JSON string
                    if isinstance(value, (dict, list)):
                        value = json.dumps(value)
                    processed_row.append(value)
                processed_rows.append(tuple(processed_row))
            
            cursor = self.conn.executemany(insert_sql, processed_rows)
            self.conn.commit()
            return cursor.rowcount
        except Exception as e:
            print(f"Error inserting rows: {e}")
            self.conn.rollback()
            return 0
    
    def _handle_information_schema_query(self, query: str) -> Tuple[List[Dict[str, Any]], str]:
        """Handle INFORMATION_SCHEMA queries"""
        import re
        
        # First normalize the query to handle unquoted references with hyphens
        # Convert: test-project.ab_testing.INFORMATION_SCHEMA.TABLES
        # To:      `test-project.ab_testing.INFORMATION_SCHEMA.TABLES`
        unquoted_info_pattern = r'\b(FROM|JOIN)\s+([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.INFORMATION_SCHEMA\.TABLES'
        
        def add_backticks_info(match):
            keyword = match.group(1)
            project = match.group(2)
            dataset = match.group(3)
            return f'{keyword} `{project}.{dataset}.INFORMATION_SCHEMA.TABLES`'
        
        query = re.sub(unquoted_info_pattern, add_backticks_info, query, flags=re.IGNORECASE)
        
        # Check if this is an INFORMATION_SCHEMA.TABLES query
        # Support multiple formats:
        # 1. FROM ab_testing.INFORMATION_SCHEMA.TABLES
        # 2. FROM `ab_testing.INFORMATION_SCHEMA.TABLES`
        # 3. FROM `project.ab_testing.INFORMATION_SCHEMA.TABLES`
        
        # Pattern 1: With backticks and project ID: `project.dataset.INFORMATION_SCHEMA.TABLES`
        pattern1 = r'FROM\s+`([^`]+)\.([^`]+)\.INFORMATION_SCHEMA\.TABLES`'
        match = re.search(pattern1, query, re.IGNORECASE)
        
        if match:
            # Has project ID
            dataset_id = match.group(2)
        else:
            # Pattern 2: Without project ID: dataset.INFORMATION_SCHEMA.TABLES or `dataset.INFORMATION_SCHEMA.TABLES`
            pattern2 = r'FROM\s+`?([^`\.\s]+)\.INFORMATION_SCHEMA\.TABLES`?'
            match = re.search(pattern2, query, re.IGNORECASE)
            
            if not match:
                return None, None
            
            dataset_id = match.group(1)
        
        try:
            # Get all tables from SQLite
            cursor = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
            all_tables = cursor.fetchall()
            
            # Filter tables that belong to this dataset
            # Table naming format: project_dataset_table
            # Example: "local-project_ab_testing_ab_Appliances"
            results = []
            for row in all_tables:
                table_name = row[0]
                
                # Look for pattern: {anything}_{dataset_id}_{table_id}
                # Use regex to find dataset_id in the table name
                pattern = rf'^(.+?)_{re.escape(dataset_id)}_(.+)$'
                table_match = re.match(pattern, table_name)
                
                if table_match:
                    project_id = table_match.group(1)
                    table_id = table_match.group(2)
                    
                    results.append({
                        'table_name': table_id,
                        'table_catalog': project_id,
                        'table_schema': dataset_id,
                        'table_type': 'BASE TABLE'
                    })
            
            return results, None
        except Exception as e:
            return [], str(e)
    
    def _split_function_args(self, args_str: str) -> List[str]:
        """
        Split function arguments by comma, respecting nested parentheses and quotes.

        Example: "a, func(b, c), 'd,e'" -> ["a", "func(b, c)", "'d,e'"]
        """
        parts = []
        current = []
        depth = 0
        in_string = False
        string_char = None

        for char in args_str:
            if char in ('"', "'") and not in_string:
                in_string = True
                string_char = char
                current.append(char)
            elif char == string_char and in_string:
                in_string = False
                string_char = None
                current.append(char)
            elif char == '(' and not in_string:
                depth += 1
                current.append(char)
            elif char == ')' and not in_string:
                depth -= 1
                current.append(char)
            elif char == ',' and depth == 0 and not in_string:
                parts.append(''.join(current).strip())
                current = []
            else:
                current.append(char)

        if current:
            parts.append(''.join(current).strip())

        return parts

    def _convert_table_ref_to_sqlite(self, table_ref: str) -> str:
        """Convert BigQuery table reference to SQLite table name"""
        # Remove backticks if present
        table_ref = table_ref.strip('`')

        # Handle project:dataset.table format
        if ':' in table_ref:
            parts = table_ref.split(':')
            project = parts[0]
            dataset_table = parts[1].split('.')
            if len(dataset_table) == 2:
                return f'"{project}_{dataset_table[0]}_{dataset_table[1]}"'

        # Handle project.dataset.table format
        parts = table_ref.split('.')
        if len(parts) == 3:
            return f'"{parts[0]}_{parts[1]}_{parts[2]}"'
        elif len(parts) == 2:
            return f'"local-project_{parts[0]}_{parts[1]}"'

        # Single table name
        return f'"{table_ref}"'

    def _convert_merge_to_sqlite(self, query: str) -> str:
        """
        Convert BigQuery MERGE statement to SQLite compatible SQL.

        BigQuery MERGE syntax:
            MERGE target_table [AS] T
            USING source_table [AS] S
            ON merge_condition
            WHEN MATCHED [AND condition] THEN
                UPDATE SET column1 = value1, ...
            WHEN NOT MATCHED [AND condition] THEN
                INSERT (column1, ...) VALUES (value1, ...)
            WHEN NOT MATCHED BY SOURCE [AND condition] THEN
                DELETE

        SQLite doesn't support MERGE directly, so we convert to:
            INSERT OR REPLACE for simple cases, or
            Multiple UPDATE/INSERT/DELETE statements for complex cases
        """
        import re

        # First, convert JSON type literals in the query
        query = re.sub(r'\bJSON\s+\'([^\']*)\'\s*', r"'\1'", query, flags=re.IGNORECASE)
        query = re.sub(r'\bJSON\s+"([^"]*)"\s*', r"'\1'", query, flags=re.IGNORECASE)

        # Parse the MERGE statement
        # Extract target table
        target_match = re.search(
            r'MERGE\s+(?:INTO\s+)?(`[^`]+`|[\w.-]+)\s+(?:AS\s+)?(\w+)?',
            query, re.IGNORECASE
        )
        if not target_match:
            return query  # Can't parse, return as-is

        target_table_raw = target_match.group(1)
        target_alias = target_match.group(2) or 'T'
        target_table = self._convert_table_ref_to_sqlite(target_table_raw)

        # Extract source table/subquery
        using_match = re.search(
            r'USING\s+(\([^)]+\)|`[^`]+`|[\w.-]+)\s+(?:AS\s+)?(\w+)?',
            query, re.IGNORECASE
        )
        if not using_match:
            return query

        source_expr = using_match.group(1)
        source_alias = using_match.group(2) or 'S'

        # Convert source table reference if it's a table (not a subquery)
        if not source_expr.startswith('('):
            source_expr = self._convert_table_ref_to_sqlite(source_expr)

        # Extract ON condition
        on_match = re.search(r'\bON\s+(.+?)(?=\s+WHEN\b)', query, re.IGNORECASE | re.DOTALL)
        if not on_match:
            return query

        on_condition = on_match.group(1).strip()
        # Replace aliases with actual references
        on_condition = re.sub(rf'\b{target_alias}\.', f'{target_table}.', on_condition)
        on_condition = re.sub(rf'\b{source_alias}\.', f'{source_expr}.', on_condition)

        # Extract WHEN MATCHED clause
        matched_update = None
        matched_match = re.search(
            r'WHEN\s+MATCHED\s+(?:AND\s+.+?\s+)?THEN\s+UPDATE\s+SET\s+(.+?)(?=\s*WHEN\s+NOT\s+MATCHED\b|\s*$)',
            query, re.IGNORECASE | re.DOTALL
        )
        if matched_match:
            matched_update = matched_match.group(1).strip()
            # Remove trailing whitespace and newlines
            matched_update = re.sub(r'\s+$', '', matched_update)
            # Replace aliases
            matched_update = re.sub(rf'\b{target_alias}\.', '', matched_update)
            matched_update = re.sub(rf'\b{source_alias}\.', f'{source_expr}.', matched_update)

        # Extract WHEN NOT MATCHED clause (INSERT)
        not_matched_insert = None
        not_matched_match = re.search(
            r'WHEN\s+NOT\s+MATCHED\s+(?:BY\s+TARGET\s+)?(?:AND\s+.+?\s+)?THEN\s+INSERT\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)',
            query, re.IGNORECASE | re.DOTALL
        )
        if not_matched_match:
            insert_cols = not_matched_match.group(1).strip()
            insert_vals = not_matched_match.group(2).strip()
            # Replace aliases in values
            insert_vals = re.sub(rf'\b{source_alias}\.', f'{source_expr}.', insert_vals)
            not_matched_insert = (insert_cols, insert_vals)

        # Build SQLite equivalent using INSERT OR REPLACE or separate statements
        # For simplicity, use a transaction with UPDATE + INSERT

        statements = []

        # UPDATE for matched rows
        # We need to use a subquery to get values from source
        if matched_update:
            # Replace source_expr references in the SET clause with a subquery approach
            # Use UPDATE ... FROM syntax (SQLite 3.33+)
            set_clause = matched_update
            # Replace source.column references back to use alias
            set_clause = re.sub(rf'{re.escape(source_expr)}\.(\w+)', r'_src.\1', set_clause)

            update_sql = f"""UPDATE {target_table} SET {set_clause}
FROM {source_expr} AS _src
WHERE {on_condition.replace(source_expr + '.', '_src.')}"""
            statements.append(update_sql)

        # INSERT for non-matched rows (from source)
        if not_matched_insert:
            insert_cols, insert_vals = not_matched_insert
            # Replace source references in values
            insert_vals_fixed = re.sub(rf'{re.escape(source_expr)}\.(\w+)', r'_src.\1', insert_vals)
            on_cond_fixed = on_condition.replace(source_expr + '.', '_src.')

            insert_sql = f"""INSERT INTO {target_table} ({insert_cols})
SELECT {insert_vals_fixed} FROM {source_expr} AS _src
WHERE NOT EXISTS (SELECT 1 FROM {target_table} WHERE {on_cond_fixed})"""
            statements.append(insert_sql)

        # Join statements with semicolon for execution
        if statements:
            return '; '.join(statements)

        return query

    def _normalize_query(self, query: str) -> str:
        """
        Normalize BigQuery syntax to SQLite-compatible format

        Handles:
        - Unquoted project.dataset.table references
        - Backtick-quoted references
        - INFORMATION_SCHEMA queries
        - BigQuery-specific functions (TIMESTAMP, CURRENT_TIMESTAMP, etc.)
        - Data type conversions
        - String/Date/Math functions
        """
        import re

        # First, handle INFORMATION_SCHEMA queries separately
        if 'INFORMATION_SCHEMA' in query.upper():
            return query  # Will be handled by _handle_information_schema_query

        # ==================== Date/Time Functions ====================

        # Convert BigQuery TIMESTAMP('...') to just the string value '...'
        # SQLite stores timestamps as TEXT, so we just need the string
        query = re.sub(r'\bTIMESTAMP\s*\(\s*([\'"][^\'"]+[\'"])\s*\)', r'\1', query, flags=re.IGNORECASE)

        # Convert CURRENT_TIMESTAMP() to datetime('now') for SQLite
        query = re.sub(r'\bCURRENT_TIMESTAMP\s*\(\s*\)', "datetime('now')", query, flags=re.IGNORECASE)

        # Convert CURRENT_DATE() to date('now')
        query = re.sub(r'\bCURRENT_DATE\s*\(\s*\)', "date('now')", query, flags=re.IGNORECASE)

        # Convert CURRENT_TIME() to time('now')
        query = re.sub(r'\bCURRENT_TIME\s*\(\s*\)', "time('now')", query, flags=re.IGNORECASE)

        # Convert DATE('...') to just the string value
        query = re.sub(r'\bDATE\s*\(\s*([\'"][^\'"]+[\'"])\s*\)', r'\1', query, flags=re.IGNORECASE)

        # Convert DATETIME('...') to just the string value
        query = re.sub(r'\bDATETIME\s*\(\s*([\'"][^\'"]+[\'"])\s*\)', r'\1', query, flags=re.IGNORECASE)

        # Convert DATE_ADD(date, INTERVAL n DAY/MONTH/YEAR) to date(date, '+n day/month/year')
        def convert_date_add(match):
            date_expr = match.group(1)
            interval_num = match.group(2)
            interval_unit = match.group(3).lower()
            return f"date({date_expr}, '+{interval_num} {interval_unit}')"
        query = re.sub(r'\bDATE_ADD\s*\(\s*(.+?)\s*,\s*INTERVAL\s+(\d+)\s+(DAY|MONTH|YEAR)\s*\)',
                       convert_date_add, query, flags=re.IGNORECASE)

        # Convert DATE_SUB(date, INTERVAL n DAY/MONTH/YEAR) to date(date, '-n day/month/year')
        def convert_date_sub(match):
            date_expr = match.group(1)
            interval_num = match.group(2)
            interval_unit = match.group(3).lower()
            return f"date({date_expr}, '-{interval_num} {interval_unit}')"
        query = re.sub(r'\bDATE_SUB\s*\(\s*(.+?)\s*,\s*INTERVAL\s+(\d+)\s+(DAY|MONTH|YEAR)\s*\)',
                       convert_date_sub, query, flags=re.IGNORECASE)

        # Convert TIMESTAMP_ADD(ts, INTERVAL n SECOND/MINUTE/HOUR/DAY)
        def convert_timestamp_add(match):
            ts_expr = match.group(1)
            interval_num = match.group(2)
            interval_unit = match.group(3).lower()
            return f"datetime({ts_expr}, '+{interval_num} {interval_unit}')"
        query = re.sub(r'\bTIMESTAMP_ADD\s*\(\s*(.+?)\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY)\s*\)',
                       convert_timestamp_add, query, flags=re.IGNORECASE)

        # Convert TIMESTAMP_SUB(ts, INTERVAL n SECOND/MINUTE/HOUR/DAY)
        def convert_timestamp_sub(match):
            ts_expr = match.group(1)
            interval_num = match.group(2)
            interval_unit = match.group(3).lower()
            return f"datetime({ts_expr}, '-{interval_num} {interval_unit}')"
        query = re.sub(r'\bTIMESTAMP_SUB\s*\(\s*(.+?)\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY)\s*\)',
                       convert_timestamp_sub, query, flags=re.IGNORECASE)

        # Convert EXTRACT(part FROM date) to strftime format
        def convert_extract(match):
            part = match.group(1).upper()
            date_expr = match.group(2)
            format_map = {
                'YEAR': '%Y',
                'MONTH': '%m',
                'DAY': '%d',
                'HOUR': '%H',
                'MINUTE': '%M',
                'SECOND': '%S',
                'DAYOFWEEK': '%w',
                'DAYOFYEAR': '%j',
                'WEEK': '%W'
            }
            fmt = format_map.get(part, '%Y')
            return f"CAST(strftime('{fmt}', {date_expr}) AS INTEGER)"
        query = re.sub(r'\bEXTRACT\s*\(\s*(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|DAYOFWEEK|DAYOFYEAR|WEEK)\s+FROM\s+(.+?)\s*\)',
                       convert_extract, query, flags=re.IGNORECASE)

        # Convert DATE_TRUNC(date, part) to appropriate strftime
        def convert_date_trunc(match):
            date_expr = match.group(1)
            part = match.group(2).upper()
            if part == 'YEAR':
                return f"date({date_expr}, 'start of year')"
            elif part == 'MONTH':
                return f"date({date_expr}, 'start of month')"
            elif part == 'DAY':
                return f"date({date_expr})"
            return match.group(0)
        query = re.sub(r'\bDATE_TRUNC\s*\(\s*(.+?)\s*,\s*(YEAR|MONTH|DAY)\s*\)',
                       convert_date_trunc, query, flags=re.IGNORECASE)

        # Convert DATE_DIFF(date1, date2, part) to julianday difference
        def convert_date_diff(match):
            date1 = match.group(1)
            date2 = match.group(2)
            part = match.group(3).upper()
            if part == 'DAY':
                return f"CAST(julianday({date1}) - julianday({date2}) AS INTEGER)"
            elif part == 'MONTH':
                return f"CAST((julianday({date1}) - julianday({date2})) / 30 AS INTEGER)"
            elif part == 'YEAR':
                return f"CAST((julianday({date1}) - julianday({date2})) / 365 AS INTEGER)"
            return match.group(0)
        query = re.sub(r'\bDATE_DIFF\s*\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(DAY|MONTH|YEAR)\s*\)',
                       convert_date_diff, query, flags=re.IGNORECASE)

        # ==================== String Functions ====================

        # Convert CONCAT(a, b, ...) - SQLite uses || operator, but also supports CONCAT in newer versions
        # Keep CONCAT as is since SQLite 3.32+ supports it, or convert to ||
        # For safety, we'll convert: CONCAT(a, b) -> (a || b)
        def convert_concat(match):
            args = match.group(1)
            # Split by comma, but be careful with nested functions
            parts = self._split_function_args(args)
            return '(' + ' || '.join(parts) + ')'
        query = re.sub(r'\bCONCAT\s*\((.+?)\)(?=\s*(?:,|\)|$|FROM|WHERE|ORDER|GROUP|LIMIT|AS|\s))',
                       convert_concat, query, flags=re.IGNORECASE)

        # Convert STARTS_WITH(str, prefix) to (str LIKE prefix || '%')
        def convert_starts_with(match):
            str_expr = match.group(1)
            prefix = match.group(2)
            return f"({str_expr} LIKE {prefix} || '%')"
        query = re.sub(r'\bSTARTS_WITH\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)',
                       convert_starts_with, query, flags=re.IGNORECASE)

        # Convert ENDS_WITH(str, suffix) to (str LIKE '%' || suffix)
        def convert_ends_with(match):
            str_expr = match.group(1)
            suffix = match.group(2)
            return f"({str_expr} LIKE '%' || {suffix})"
        query = re.sub(r'\bENDS_WITH\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)',
                       convert_ends_with, query, flags=re.IGNORECASE)

        # Convert CONTAINS_SUBSTR(str, substr) to (str LIKE '%' || substr || '%')
        def convert_contains_substr(match):
            str_expr = match.group(1)
            substr = match.group(2)
            return f"({str_expr} LIKE '%' || {substr} || '%')"
        query = re.sub(r'\bCONTAINS_SUBSTR\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)',
                       convert_contains_substr, query, flags=re.IGNORECASE)

        # Convert STRING_AGG(expr, delimiter) to GROUP_CONCAT(expr, delimiter)
        query = re.sub(r'\bSTRING_AGG\s*\(', 'GROUP_CONCAT(', query, flags=re.IGNORECASE)

        # Convert FORMAT_DATE(format, date) - basic conversion
        # BigQuery format: %Y-%m-%d, SQLite uses same strftime format
        def convert_format_date(match):
            fmt = match.group(1)
            date_expr = match.group(2)
            return f"strftime({fmt}, {date_expr})"
        query = re.sub(r'\bFORMAT_DATE\s*\(\s*([\'"][^\'"]+[\'"])\s*,\s*(.+?)\s*\)',
                       convert_format_date, query, flags=re.IGNORECASE)

        # Convert FORMAT_TIMESTAMP similarly
        query = re.sub(r'\bFORMAT_TIMESTAMP\s*\(\s*([\'"][^\'"]+[\'"])\s*,\s*(.+?)\s*\)',
                       convert_format_date, query, flags=re.IGNORECASE)

        # ==================== Type Casting ====================

        # Convert SAFE_CAST(x AS type) to CAST(x AS type) - SQLite doesn't have SAFE_CAST
        query = re.sub(r'\bSAFE_CAST\s*\(', 'CAST(', query, flags=re.IGNORECASE)

        # Convert INT64 to INTEGER in CAST
        query = re.sub(r'\bCAST\s*\((.+?)\s+AS\s+INT64\s*\)', r'CAST(\1 AS INTEGER)', query, flags=re.IGNORECASE)

        # Convert FLOAT64 to REAL in CAST
        query = re.sub(r'\bCAST\s*\((.+?)\s+AS\s+FLOAT64\s*\)', r'CAST(\1 AS REAL)', query, flags=re.IGNORECASE)

        # Convert BOOL/BOOLEAN to INTEGER in CAST
        query = re.sub(r'\bCAST\s*\((.+?)\s+AS\s+BOOL(EAN)?\s*\)', r'CAST(\1 AS INTEGER)', query, flags=re.IGNORECASE)

        # ==================== Math Functions ====================

        # Convert SAFE_DIVIDE(a, b) to (CASE WHEN b = 0 THEN NULL ELSE a / b END)
        def convert_safe_divide(match):
            a = match.group(1)
            b = match.group(2)
            return f"(CASE WHEN {b} = 0 THEN NULL ELSE {a} * 1.0 / {b} END)"
        query = re.sub(r'\bSAFE_DIVIDE\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)',
                       convert_safe_divide, query, flags=re.IGNORECASE)

        # Convert DIV(a, b) to (a / b) - integer division
        def convert_div(match):
            a = match.group(1)
            b = match.group(2)
            return f"({a} / {b})"
        query = re.sub(r'\bDIV\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)',
                       convert_div, query, flags=re.IGNORECASE)

        # Convert MOD(a, b) to (a % b)
        def convert_mod(match):
            a = match.group(1)
            b = match.group(2)
            return f"({a} % {b})"
        query = re.sub(r'\bMOD\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)',
                       convert_mod, query, flags=re.IGNORECASE)

        # Convert POWER(a, b) to pow(a, b) - note: SQLite doesn't have POWER, use multiplication for simple cases
        # Actually SQLite has no built-in power function, we can use: a * a for square, etc.
        # For now, leave as is and hope for extension support, or convert simple cases

        # Convert LOG(x) to ln(x) - SQLite doesn't have LOG, needs extension
        # Convert LN(x) - SQLite doesn't have LN either
        # Leave these as potential issues for now

        # ==================== Conditional Functions ====================

        # Convert IF(condition, true_val, false_val) to CASE WHEN condition THEN true_val ELSE false_val END
        def convert_if(match):
            condition = match.group(1)
            true_val = match.group(2)
            false_val = match.group(3)
            return f"(CASE WHEN {condition} THEN {true_val} ELSE {false_val} END)"
        # Be careful with IF - need to avoid matching things like IFERROR, IFNULL
        query = re.sub(r'\bIF\s*\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(.+?)\s*\)(?!\w)',
                       convert_if, query, flags=re.IGNORECASE)

        # IFNULL is supported in SQLite - no conversion needed
        # NULLIF is supported in SQLite - no conversion needed
        # COALESCE is supported in SQLite - no conversion needed

        # ==================== Aggregate Functions ====================

        # Convert COUNTIF(condition) to SUM(CASE WHEN condition THEN 1 ELSE 0 END)
        def convert_countif(match):
            condition = match.group(1)
            return f"SUM(CASE WHEN {condition} THEN 1 ELSE 0 END)"
        query = re.sub(r'\bCOUNTIF\s*\(\s*(.+?)\s*\)',
                       convert_countif, query, flags=re.IGNORECASE)

        # Convert APPROX_COUNT_DISTINCT(x) to COUNT(DISTINCT x)
        query = re.sub(r'\bAPPROX_COUNT_DISTINCT\s*\(', 'COUNT(DISTINCT ', query, flags=re.IGNORECASE)

        # Convert ARRAY_AGG to GROUP_CONCAT (limited support)
        query = re.sub(r'\bARRAY_AGG\s*\(', 'GROUP_CONCAT(', query, flags=re.IGNORECASE)

        # ==================== JSON Type Literals ====================

        # Convert BigQuery JSON type syntax: JSON '{"key": "value"}' -> '{"key": "value"}'
        # Also handles JSON "..." with double quotes
        query = re.sub(r'\bJSON\s+\'([^\']*)\'\s*', r"'\1'", query, flags=re.IGNORECASE)
        query = re.sub(r'\bJSON\s+"([^"]*)"\s*', r"'\1'", query, flags=re.IGNORECASE)

        # ==================== Boolean Literals ====================

        # Convert TRUE/FALSE to 1/0 for SQLite
        # But NOT inside quoted strings (to preserve JSON values)
        def replace_bool_outside_strings(query: str, bool_val: str, replacement: str) -> str:
            """Replace boolean values only outside of quoted strings"""
            result = []
            i = 0
            while i < len(query):
                # Check for quoted strings
                if query[i] in ('"', "'"):
                    quote_char = query[i]
                    end = i + 1
                    while end < len(query) and query[end] != quote_char:
                        if query[end] == '\\':
                            end += 2
                        else:
                            end += 1
                    if end < len(query):
                        end += 1
                    result.append(query[i:end])
                    i = end
                else:
                    # Check for boolean keyword at word boundary
                    if query[i:i+len(bool_val)].upper() == bool_val.upper():
                        # Check word boundaries
                        before_ok = (i == 0 or not query[i-1].isalnum() and query[i-1] != '_')
                        after_pos = i + len(bool_val)
                        after_ok = (after_pos >= len(query) or not query[after_pos].isalnum() and query[after_pos] != '_')
                        if before_ok and after_ok:
                            result.append(replacement)
                            i = after_pos
                            continue
                    result.append(query[i])
                    i += 1
            return ''.join(result)

        query = replace_bool_outside_strings(query, 'TRUE', '1')
        query = replace_bool_outside_strings(query, 'FALSE', '0')

        # ==================== LIMIT OFFSET syntax ====================
        # BigQuery uses LIMIT x OFFSET y, SQLite uses LIMIT x OFFSET y (same, no change needed)

        # ==================== MERGE Statement ====================

        # Convert BigQuery MERGE to SQLite INSERT OR REPLACE / UPDATE
        # This is handled separately in _convert_merge_to_sqlite method
        if re.match(r'^\s*MERGE\b', query, re.IGNORECASE):
            query = self._convert_merge_to_sqlite(query)
            return query

        # ==================== Table References ====================

        # Replace unquoted project.dataset.table patterns with backticks
        # This handles cases like: FROM test-project.ab_testing.table_name
        # Convert to: FROM `test-project.ab_testing.table_name`
        
        # Pattern: FROM/JOIN followed by project.dataset.table (with possible hyphens/underscores)
        # Match alphanumeric, hyphens, and underscores in identifiers
        unquoted_pattern = r'\b(FROM|JOIN)\s+([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\b'
        
        def add_backticks(match):
            keyword = match.group(1)
            project = match.group(2)
            dataset = match.group(3)
            table = match.group(4)
            return f'{keyword} `{project}.{dataset}.{table}`'
        
        query = re.sub(unquoted_pattern, add_backticks, query, flags=re.IGNORECASE)
        
        # Now handle backtick-quoted table names
        # `project:dataset.table` or `project.dataset.table` -> "project_dataset_table"
        def replace_table_ref(match):
            table_ref = match.group(1)
            
            # Handle project:dataset.table format (BigQuery standard)
            if ':' in table_ref:
                parts = table_ref.split(':')
                project = parts[0]
                dataset_table = parts[1].split('.')
                if len(dataset_table) == 2:
                    return f'"{project}_{dataset_table[0]}_{dataset_table[1]}"'
            
            # Handle project.dataset.table format
            parts = table_ref.split('.')
            if len(parts) == 3:
                # Three parts: project.dataset.table
                return f'"{parts[0]}_{parts[1]}_{parts[2]}"'
            elif len(parts) == 2:
                # Two parts: dataset.table (assume default project)
                return f'"local-project_{parts[0]}_{parts[1]}"'
            return match.group(0)
        
        query = re.sub(r'`([^`]+)`', replace_table_ref, query)
        
        return query
    
    def execute_query(self, query: str, params: Optional[Tuple] = None) -> Tuple[List[Dict[str, Any]], str]:
        """
        Execute a SQL query and return results
        
        Returns:
            Tuple of (results, error_message)
        """
        try:
            # Check if this is an INFORMATION_SCHEMA query
            if 'INFORMATION_SCHEMA' in query.upper():
                results, error = self._handle_information_schema_query(query)
                if results is not None or error is not None:
                    return results, error
            
            # Normalize BigQuery syntax to SQLite format
            query = self._normalize_query(query)

            # Handle multi-statement queries (e.g., from MERGE conversion)
            # Split by semicolon and execute each statement
            statements = [s.strip() for s in query.split(';') if s.strip()]

            rows = []
            cursor = None
            for stmt in statements:
                cursor = self.conn.execute(stmt, params or ())

                # Commit for write operations (INSERT, UPDATE, DELETE)
                stmt_upper = stmt.upper().strip()
                if stmt_upper.startswith(('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'MERGE')):
                    self.conn.commit()

                # Only fetch results from the last statement (or SELECT statements)
                if stmt_upper.startswith('SELECT') or len(statements) == 1:
                    rows = cursor.fetchall()
            
            # Convert to list of dicts
            results = []
            for row in rows:
                row_dict = {}
                for key in row.keys():
                    value = row[key]
                    # Try to parse JSON strings back to objects
                    if isinstance(value, str):
                        try:
                            # Check if it looks like JSON
                            if value.startswith('{') or value.startswith('['):
                                value = json.loads(value)
                        except:
                            pass
                    row_dict[key] = value
                results.append(row_dict)
            
            return results, None
        except Exception as e:
            return [], str(e)
    
    def update_rows(self, project_id: str, dataset_id: str, table_id: str,
                   updates: Dict[str, Any], where_clause: str) -> int:
        """Update rows in a table"""
        try:
            table_name = self._get_table_name(project_id, dataset_id, table_id)
            
            # Build UPDATE statement
            set_clauses = [f'"{col}" = ?' for col in updates.keys()]
            update_sql = f"UPDATE {table_name} SET {', '.join(set_clauses)}"
            
            if where_clause:
                update_sql += f" WHERE {where_clause}"
            
            # Convert values
            values = []
            for val in updates.values():
                if isinstance(val, (dict, list)):
                    val = json.dumps(val)
                values.append(val)
            
            cursor = self.conn.execute(update_sql, tuple(values))
            self.conn.commit()
            return cursor.rowcount
        except Exception as e:
            print(f"Error updating rows: {e}")
            self.conn.rollback()
            return 0
    
    def delete_rows(self, project_id: str, dataset_id: str, table_id: str, 
                   where_clause: str) -> int:
        """Delete rows from a table"""
        try:
            table_name = self._get_table_name(project_id, dataset_id, table_id)
            
            delete_sql = f"DELETE FROM {table_name}"
            if where_clause:
                delete_sql += f" WHERE {where_clause}"
            
            cursor = self.conn.execute(delete_sql)
            self.conn.commit()
            return cursor.rowcount
        except Exception as e:
            print(f"Error deleting rows: {e}")
            self.conn.rollback()
            return 0
    
    def get_row_count(self, project_id: str, dataset_id: str, table_id: str) -> int:
        """Get the number of rows in a table"""
        try:
            table_name = self._get_table_name(project_id, dataset_id, table_id)
            cursor = self.conn.execute(f"SELECT COUNT(*) FROM {table_name}")
            return cursor.fetchone()[0]
        except:
            return 0
    
    def drop_table(self, project_id: str, dataset_id: str, table_id: str) -> bool:
        """Drop a table"""
        try:
            table_name = self._get_table_name(project_id, dataset_id, table_id)
            self.conn.execute(f"DROP TABLE IF EXISTS {table_name}")
            self.conn.commit()
            return True
        except Exception as e:
            print(f"Error dropping table: {e}")
            return False
    
    def truncate_table(self, project_id: str, dataset_id: str, table_id: str) -> bool:
        """Truncate a table (delete all rows)"""
        try:
            table_name = self._get_table_name(project_id, dataset_id, table_id)
            self.conn.execute(f"DELETE FROM {table_name}")
            self.conn.commit()
            return True
        except Exception as e:
            print(f"Error truncating table: {e}")
            return False
    
    def close(self):
        """Close database connection"""
        if self.conn:
            self.conn.close()
    
    def __del__(self):
        """Cleanup"""
        self.close()

