"""
Database utilities for Google Cloud MCP Server

Handles data operations for the simplified Google Cloud implementation,
including BigQuery, Cloud Storage, Compute Engine, and IAM.

Uses SQLite for real SQL operations and JSON for metadata.
"""

import os
import sys
from typing import Dict, List, Any, Optional
import json
from datetime import datetime, timezone

# Add project root and current directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)
sys.path.insert(0, current_dir)

from common.database import JsonDatabase
from sqlite_backend import SQLiteBackend


class GoogleCloudDatabase:
    """Database handler for Google Cloud data"""
    
    def __init__(self, data_dir: str = None):
        """Initialize database with data directory and SQLite backend"""
        if data_dir is None:
            # Default to data directory in the same folder as this file
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        
        self.data_dir = data_dir  # Save data directory as instance attribute
        self.json_db = JsonDatabase(data_dir)
        
        # Initialize SQLite backend for real SQL operations
        sqlite_db_path = os.path.join(data_dir, "bigquery_data.db")
        self.sqlite = SQLiteBackend(sqlite_db_path)
        
        # File mappings (metadata stored in JSON)
        self.bigquery_datasets_file = "bigquery_datasets.json"
        self.bigquery_tables_file = "bigquery_tables.json"
        self.query_results_file = "query_results.json"
        self.storage_buckets_file = "storage_buckets.json"
        self.storage_objects_file = "storage_objects.json"
        self.compute_instances_file = "compute_instances.json"
        self.iam_service_accounts_file = "iam_service_accounts.json"
        self.log_entries_file = "log_entries.json"
        self.log_buckets_file = "log_buckets.json"
        self.log_sinks_file = "log_sinks.json"
        
        # Initialize tables in SQLite from existing metadata
        self._sync_sqlite_tables()
    
    def _sync_sqlite_tables(self):
        """Sync SQLite tables with JSON metadata and import existing data"""
        try:
            # Get all tables from metadata
            tables_data = self.json_db.load_data(self.bigquery_tables_file)
            if not isinstance(tables_data, dict):
                return
            
            # Create SQLite tables based on schema
            for key, table in tables_data.items():
                project_id = table.get('projectId', '')
                dataset_id = table.get('datasetId', '')
                table_id = table.get('tableId', '')
                schema = table.get('schema', [])
                
                if project_id and dataset_id and table_id and schema:
                    # Create table in SQLite
                    self.sqlite.create_table_from_schema(project_id, dataset_id, table_id, schema)
                    
                    # Import existing data from JSON files if they exist
                    json_data_file = os.path.join(self.data_dir, "table_data", 
                                                  f"{project_id}_{dataset_id}_{table_id}.json")
                    if os.path.exists(json_data_file):
                        try:
                            with open(json_data_file, 'r') as f:
                                rows = json.load(f)
                            if rows:
                                # Check if data already exists
                                if self.sqlite.get_row_count(project_id, dataset_id, table_id) == 0:
                                    self.sqlite.insert_rows(project_id, dataset_id, table_id, rows, schema)
                        except Exception as e:
                            print(f"Warning: Could not import data for {key}: {e}")
        except Exception as e:
            print(f"Warning: Could not sync SQLite tables: {e}")
    
    # ====================== BigQuery Operations ======================
    
    def list_bigquery_datasets(self, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List BigQuery datasets, optionally filtered by project"""
        data = self.json_db.load_data(self.bigquery_datasets_file)
        datasets = list(data.values()) if isinstance(data, dict) else []
        
        if project_id:
            datasets = [d for d in datasets if d.get('projectId') == project_id]
        
        return datasets
    
    def get_bigquery_dataset(self, project_id: str, dataset_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific BigQuery dataset"""
        key = f"{project_id}:{dataset_id}"
        data = self.json_db.load_data(self.bigquery_datasets_file)
        return data.get(key) if isinstance(data, dict) else None
    
    def create_bigquery_dataset(self, project_id: str, dataset_id: str, 
                               dataset_info: Dict[str, Any]) -> bool:
        """Create a new BigQuery dataset"""
        key = f"{project_id}:{dataset_id}"
        all_data = self.json_db.load_data(self.bigquery_datasets_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        dataset_info.update({
            'datasetId': dataset_id,
            'projectId': project_id,
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        })
        
        all_data[key] = dataset_info
        return self.json_db.save_data(self.bigquery_datasets_file, all_data)
    
    def delete_bigquery_dataset(self, project_id: str, dataset_id: str) -> bool:
        """Delete a BigQuery dataset"""
        key = f"{project_id}:{dataset_id}"
        all_data = self.json_db.load_data(self.bigquery_datasets_file)
        if isinstance(all_data, dict) and key in all_data:
            del all_data[key]
            return self.json_db.save_data(self.bigquery_datasets_file, all_data)
        return False
    
    def list_bigquery_tables(self, project_id: str, dataset_id: str) -> List[Dict[str, Any]]:
        """List tables in a BigQuery dataset"""
        data = self.json_db.load_data(self.bigquery_tables_file)
        tables = list(data.values()) if isinstance(data, dict) else []
        
        return [t for t in tables 
                if t.get('projectId') == project_id and t.get('datasetId') == dataset_id]
    
    def get_bigquery_table(self, project_id: str, dataset_id: str, 
                          table_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific BigQuery table"""
        key = f"{project_id}:{dataset_id}.{table_id}"
        data = self.json_db.load_data(self.bigquery_tables_file)
        return data.get(key) if isinstance(data, dict) else None
    
    def create_bigquery_table(self, project_id: str, dataset_id: str, 
                             table_id: str, table_info: Dict[str, Any]) -> bool:
        """Create a new BigQuery table"""
        key = f"{project_id}:{dataset_id}.{table_id}"
        all_data = self.json_db.load_data(self.bigquery_tables_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        table_info.update({
            'tableId': table_id,
            'datasetId': dataset_id,
            'projectId': project_id,
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'numRows': 0,
            'numBytes': 0
        })
        
        all_data[key] = table_info
        return self.json_db.save_data(self.bigquery_tables_file, all_data)
    
    def delete_bigquery_table(self, project_id: str, dataset_id: str, table_id: str) -> bool:
        """Delete a BigQuery table"""
        key = f"{project_id}:{dataset_id}.{table_id}"
        all_data = self.json_db.load_data(self.bigquery_tables_file)
        if isinstance(all_data, dict) and key in all_data:
            # Delete from JSON metadata
            del all_data[key]
            success = self.json_db.save_data(self.bigquery_tables_file, all_data)
            
            # Also delete from SQLite
            self.sqlite.drop_table(project_id, dataset_id, table_id)
            
            return success
        return False
    
    def _get_table_data_file(self, project_id: str, dataset_id: str, table_id: str) -> str:
        """Get the file path for table data storage"""
        filename = f"{project_id}_{dataset_id}_{table_id}.json"
        return os.path.join(self.data_dir, "table_data", filename)
    
    def _load_table_data(self, project_id: str, dataset_id: str, table_id: str) -> List[Dict[str, Any]]:
        """Load actual table data from JSON file"""
        data_file = self._get_table_data_file(project_id, dataset_id, table_id)
        
        if not os.path.exists(data_file):
            return []
        
        try:
            with open(data_file, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading table data: {e}")
            return []
    
    def _save_table_data(self, project_id: str, dataset_id: str, table_id: str, data: List[Dict[str, Any]]) -> bool:
        """Save actual table data to JSON file"""
        data_file = self._get_table_data_file(project_id, dataset_id, table_id)
        
        # Ensure directory exists
        os.makedirs(os.path.dirname(data_file), exist_ok=True)
        
        try:
            with open(data_file, 'w') as f:
                json.dump(data, f, indent=2)
            
            # Update table metadata
            table = self.get_bigquery_table(project_id, dataset_id, table_id)
            if table:
                table['numRows'] = len(data)
                table['numBytes'] = len(json.dumps(data).encode('utf-8'))
                table['modified'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                
                key = f"{project_id}:{dataset_id}.{table_id}"
                all_tables = self.json_db.load_data(self.bigquery_tables_file)
                if isinstance(all_tables, dict):
                    all_tables[key] = table
                    self.json_db.save_data(self.bigquery_tables_file, all_tables)
            
            return True
        except Exception as e:
            print(f"Error saving table data: {e}")
            return False
    
    def _parse_table_reference(self, query: str) -> Optional[tuple]:
        """Parse table reference from query (project.dataset.table)"""
        import re
        
        # Match patterns like `project.dataset.table` or project.dataset.table
        pattern = r'FROM\s+[`\'"]?([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)[`\'"]?'
        match = re.search(pattern, query, re.IGNORECASE)
        
        if match:
            return (match.group(1), match.group(2), match.group(3))
        return None
    
    def _parse_where_clause(self, query: str) -> Optional[str]:
        """Parse WHERE clause from query"""
        import re
        match = re.search(r'WHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|\s*$)', query, re.IGNORECASE | re.DOTALL)
        return match.group(1).strip() if match else None
    
    def _parse_limit_clause(self, query: str) -> Optional[int]:
        """Parse LIMIT clause from query"""
        import re
        match = re.search(r'LIMIT\s+(\d+)', query, re.IGNORECASE)
        return int(match.group(1)) if match else None
    
    def _parse_order_by_clause(self, query: str) -> Optional[tuple]:
        """Parse ORDER BY clause from query"""
        import re
        match = re.search(r'ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?', query, re.IGNORECASE)
        if match:
            field = match.group(1)
            direction = match.group(2).upper() if match.group(2) else 'ASC'
            return (field, direction)
        return None
    
    def _evaluate_where_condition(self, row: Dict[str, Any], condition: str) -> bool:
        """Evaluate a simple WHERE condition against a row"""
        import re
        
        # Support simple conditions: field = 'value', field > 10, etc.
        # Pattern: field operator value
        pattern = r"(\w+)\s*(=|!=|>|<|>=|<=|LIKE)\s*(['\"]?)([^'\"]+)\3"
        match = re.search(pattern, condition, re.IGNORECASE)
        
        if not match:
            return True  # If can't parse, include the row
        
        field, operator, _, value = match.groups()
        
        if field not in row:
            return False
        
        row_value = row[field]
        
        # Type conversion
        try:
            if isinstance(row_value, (int, float)):
                value = float(value) if '.' in value else int(value)
            elif isinstance(row_value, str):
                value = str(value)
        except:
            pass
        
        # Evaluate operator
        operator = operator.upper()
        if operator == '=':
            return row_value == value
        elif operator == '!=':
            return row_value != value
        elif operator == '>':
            return row_value > value
        elif operator == '<':
            return row_value < value
        elif operator == '>=':
            return row_value >= value
        elif operator == '<=':
            return row_value <= value
        elif operator == 'LIKE':
            # Simple LIKE: convert SQL LIKE to Python regex
            pattern = value.replace('%', '.*').replace('_', '.')
            return re.search(pattern, str(row_value), re.IGNORECASE) is not None
        
        return True
    
    def _execute_simple_query(self, query: str) -> List[Dict[str, Any]]:
        """Execute a real SQL query against local data"""
        import re
        
        # Parse table reference
        table_ref = self._parse_table_reference(query)
        if not table_ref:
            return [{'error': 'Could not parse table reference from query'}]
        
        project_id, dataset_id, table_id = table_ref
        
        # Get table metadata
        table = self.get_bigquery_table(project_id, dataset_id, table_id)
        if not table:
            return [{'error': f'Table {project_id}:{dataset_id}.{table_id} not found'}]
        
        # Load actual table data
        data = self._load_table_data(project_id, dataset_id, table_id)
        
        if not data:
            return []
        
        # Parse WHERE clause
        where_condition = self._parse_where_clause(query)
        
        # Filter data based on WHERE
        if where_condition:
            filtered_data = [row for row in data if self._evaluate_where_condition(row, where_condition)]
        else:
            filtered_data = data.copy()
        
        # Parse ORDER BY clause
        order_by = self._parse_order_by_clause(query)
        if order_by:
            field, direction = order_by
            reverse = (direction == 'DESC')
            try:
                filtered_data.sort(key=lambda x: x.get(field, ''), reverse=reverse)
            except:
                pass  # Skip sorting if field doesn't exist or not comparable
        
        # Parse LIMIT clause
        limit = self._parse_limit_clause(query)
        if limit is not None:
            filtered_data = filtered_data[:limit]
        
        # Parse SELECT fields (simple version - just return all fields for now)
        # In a full implementation, we'd parse SELECT clause and filter fields
        
        return filtered_data
    
    def run_bigquery_query(self, query: str) -> Dict[str, Any]:
        """Execute a BigQuery query using real SQLite SQL engine"""
        import hashlib
        import time
        
        start_time = time.time()
        query_id = f"query-{hashlib.md5(query.encode()).hexdigest()[:8]}"
        
        # Check if query result already exists in cache
        all_results = self.json_db.load_data(self.query_results_file)
        if isinstance(all_results, dict) and query_id in all_results:
            cached_result = all_results[query_id]
            # Add cache indicator
            cached_result['cached'] = True
            return cached_result
        
        # Execute query using SQLite (real SQL engine!)
        query_results, error_message = self.sqlite.execute_query(query)
        
        status = 'DONE' if error_message is None else 'ERROR'
        execution_time = int((time.time() - start_time) * 1000)
        
        # Create query result
        result = {
            'queryId': query_id,
            'query': query,
            'status': status,
            'results': query_results,
            'totalRows': len(query_results),
            'totalBytes': len(str(query_results).encode('utf-8')),
            'creationTime': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'executionTime': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'duration_ms': execution_time,
            'cached': False
        }
        
        if error_message:
            result['error'] = error_message
        
        # Save for future reference (cache) - only cache successful queries
        if status == 'DONE':
            if not isinstance(all_results, dict):
                all_results = {}
            all_results[query_id] = result
            self.json_db.save_data(self.query_results_file, all_results)
        
        return result
    
    def get_query_result(self, query_id: str) -> Optional[Dict[str, Any]]:
        """Get results of a previous query"""
        data = self.json_db.load_data(self.query_results_file)
        return data.get(query_id) if isinstance(data, dict) else None
    
    def _invalidate_query_cache_for_table(self, project_id: str, dataset_id: str, table_id: str):
        """Invalidate all cached queries for a specific table"""
        # Clear all cached queries since we can't easily determine which queries accessed this table
        try:
            self.json_db.save_data(self.query_results_file, {})
        except:
            pass
    
    def insert_table_rows(self, project_id: str, dataset_id: str, table_id: str, rows: List[Dict[str, Any]]) -> bool:
        """Insert rows into a BigQuery table using real SQL INSERT"""
        # Get table schema
        table = self.get_bigquery_table(project_id, dataset_id, table_id)
        if not table:
            return False
        
        schema = table.get('schema', [])
        
        # Insert using SQLite
        inserted_count = self.sqlite.insert_rows(project_id, dataset_id, table_id, rows, schema)
        success = inserted_count > 0
        
        # Update metadata
        if success:
            new_row_count = self.sqlite.get_row_count(project_id, dataset_id, table_id)
            table['numRows'] = new_row_count
            table['modified'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            
            key = f"{project_id}:{dataset_id}.{table_id}"
            all_tables = self.json_db.load_data(self.bigquery_tables_file)
            if isinstance(all_tables, dict):
                all_tables[key] = table
                self.json_db.save_data(self.bigquery_tables_file, all_tables)
            
            # Invalidate query cache
            self._invalidate_query_cache_for_table(project_id, dataset_id, table_id)
        
        return success
    
    def update_table_rows(self, project_id: str, dataset_id: str, table_id: str, 
                          condition: str, updates: Dict[str, Any]) -> int:
        """Update rows in a BigQuery table using real SQL UPDATE"""
        # Use SQLite for update
        updated_count = self.sqlite.update_rows(project_id, dataset_id, table_id, updates, condition)
        
        # Update metadata
        if updated_count > 0:
            table = self.get_bigquery_table(project_id, dataset_id, table_id)
            if table:
                table['modified'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                
                key = f"{project_id}:{dataset_id}.{table_id}"
                all_tables = self.json_db.load_data(self.bigquery_tables_file)
                if isinstance(all_tables, dict):
                    all_tables[key] = table
                    self.json_db.save_data(self.bigquery_tables_file, all_tables)
            
            # Invalidate query cache
            self._invalidate_query_cache_for_table(project_id, dataset_id, table_id)
        
        return updated_count
    
    def delete_table_rows(self, project_id: str, dataset_id: str, table_id: str, condition: str) -> int:
        """Delete rows from a BigQuery table using real SQL DELETE"""
        # Use SQLite for delete
        deleted_count = self.sqlite.delete_rows(project_id, dataset_id, table_id, condition)
        
        # Update metadata
        if deleted_count > 0:
            table = self.get_bigquery_table(project_id, dataset_id, table_id)
            if table:
                new_row_count = self.sqlite.get_row_count(project_id, dataset_id, table_id)
                table['numRows'] = new_row_count
                table['modified'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                
                key = f"{project_id}:{dataset_id}.{table_id}"
                all_tables = self.json_db.load_data(self.bigquery_tables_file)
                if isinstance(all_tables, dict):
                    all_tables[key] = table
                    self.json_db.save_data(self.bigquery_tables_file, all_tables)
            
            # Invalidate query cache
            self._invalidate_query_cache_for_table(project_id, dataset_id, table_id)
        
        return deleted_count
    
    def truncate_table(self, project_id: str, dataset_id: str, table_id: str) -> bool:
        """Delete all rows from a table using real SQL"""
        success = self.sqlite.truncate_table(project_id, dataset_id, table_id)
        
        if success:
            # Update metadata
            table = self.get_bigquery_table(project_id, dataset_id, table_id)
            if table:
                table['numRows'] = 0
                table['modified'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                
                key = f"{project_id}:{dataset_id}.{table_id}"
                all_tables = self.json_db.load_data(self.bigquery_tables_file)
                if isinstance(all_tables, dict):
                    all_tables[key] = table
                    self.json_db.save_data(self.bigquery_tables_file, all_tables)
            
            # Invalidate query cache
            self._invalidate_query_cache_for_table(project_id, dataset_id, table_id)
        
        return success
    
    # ====================== Cloud Storage Operations ======================
    
    def list_storage_buckets(self) -> List[Dict[str, Any]]:
        """List all Cloud Storage buckets"""
        data = self.json_db.load_data(self.storage_buckets_file)
        return list(data.values()) if isinstance(data, dict) else []
    
    def get_storage_bucket(self, bucket_name: str) -> Optional[Dict[str, Any]]:
        """Get a specific Cloud Storage bucket"""
        data = self.json_db.load_data(self.storage_buckets_file)
        return data.get(bucket_name) if isinstance(data, dict) else None
    
    def create_storage_bucket(self, bucket_name: str, bucket_info: Dict[str, Any]) -> bool:
        """Create a new Cloud Storage bucket"""
        all_data = self.json_db.load_data(self.storage_buckets_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        bucket_info.update({
            'name': bucket_name,
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'updated': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        })
        
        all_data[bucket_name] = bucket_info
        return self.json_db.save_data(self.storage_buckets_file, all_data)
    
    def delete_storage_bucket(self, bucket_name: str) -> bool:
        """Delete a Cloud Storage bucket"""
        all_data = self.json_db.load_data(self.storage_buckets_file)
        if isinstance(all_data, dict) and bucket_name in all_data:
            del all_data[bucket_name]
            return self.json_db.save_data(self.storage_buckets_file, all_data)
        return False
    
    def list_storage_objects(self, bucket_name: str, prefix: Optional[str] = None) -> List[Dict[str, Any]]:
        """List objects in a Cloud Storage bucket"""
        data = self.json_db.load_data(self.storage_objects_file)
        objects = list(data.values()) if isinstance(data, dict) else []
        
        objects = [obj for obj in objects if obj.get('bucket') == bucket_name]
        
        if prefix:
            objects = [obj for obj in objects if obj.get('name', '').startswith(prefix)]
        
        return objects
    
    def get_storage_object(self, bucket_name: str, object_name: str) -> Optional[Dict[str, Any]]:
        """Get a specific Cloud Storage object"""
        key = f"{bucket_name}/{object_name}"
        data = self.json_db.load_data(self.storage_objects_file)
        return data.get(key) if isinstance(data, dict) else None
    
    def upload_storage_object(self, bucket_name: str, object_name: str,
                             object_info: Dict[str, Any]) -> bool:
        """Upload an object to Cloud Storage

        Raises:
            ValueError: If the bucket does not exist.
        """
        # Check if bucket exists
        if self.get_storage_bucket(bucket_name) is None:
            raise ValueError(f"Bucket '{bucket_name}' does not exist")

        key = f"{bucket_name}/{object_name}"
        all_data = self.json_db.load_data(self.storage_objects_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        object_info.update({
            'name': object_name,
            'bucket': bucket_name,
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'updated': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        })
        
        all_data[key] = object_info
        return self.json_db.save_data(self.storage_objects_file, all_data)
    
    def delete_storage_object(self, bucket_name: str, object_name: str) -> bool:
        """Delete an object from Cloud Storage"""
        key = f"{bucket_name}/{object_name}"
        all_data = self.json_db.load_data(self.storage_objects_file)
        if isinstance(all_data, dict) and key in all_data:
            del all_data[key]
            return self.json_db.save_data(self.storage_objects_file, all_data)
        return False
    
    # ====================== Compute Engine Operations ======================
    
    def list_compute_instances(self, zone: Optional[str] = None) -> List[Dict[str, Any]]:
        """List Compute Engine instances, optionally filtered by zone"""
        data = self.json_db.load_data(self.compute_instances_file)
        instances = list(data.values()) if isinstance(data, dict) else []
        
        if zone:
            instances = [i for i in instances if i.get('zone') == zone]
        
        return instances
    
    def get_compute_instance(self, instance_name: str) -> Optional[Dict[str, Any]]:
        """Get a specific Compute Engine instance"""
        data = self.json_db.load_data(self.compute_instances_file)
        return data.get(instance_name) if isinstance(data, dict) else None
    
    def create_compute_instance(self, instance_name: str, instance_info: Dict[str, Any]) -> bool:
        """Create a new Compute Engine instance"""
        all_data = self.json_db.load_data(self.compute_instances_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        instance_info.update({
            'name': instance_name,
            'status': 'PROVISIONING',
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        })
        
        all_data[instance_name] = instance_info
        return self.json_db.save_data(self.compute_instances_file, all_data)
    
    def delete_compute_instance(self, instance_name: str) -> bool:
        """Delete a Compute Engine instance"""
        all_data = self.json_db.load_data(self.compute_instances_file)
        if isinstance(all_data, dict) and instance_name in all_data:
            del all_data[instance_name]
            return self.json_db.save_data(self.compute_instances_file, all_data)
        return False
    
    def start_compute_instance(self, instance_name: str) -> bool:
        """Start a Compute Engine instance"""
        all_data = self.json_db.load_data(self.compute_instances_file)
        if isinstance(all_data, dict) and instance_name in all_data:
            all_data[instance_name]['status'] = 'RUNNING'
            all_data[instance_name]['lastStarted'] = datetime.utcnow().isoformat() + 'Z'
            return self.json_db.save_data(self.compute_instances_file, all_data)
        return False
    
    def stop_compute_instance(self, instance_name: str) -> bool:
        """Stop a Compute Engine instance"""
        all_data = self.json_db.load_data(self.compute_instances_file)
        if isinstance(all_data, dict) and instance_name in all_data:
            all_data[instance_name]['status'] = 'TERMINATED'
            all_data[instance_name]['lastStopped'] = datetime.utcnow().isoformat() + 'Z'
            return self.json_db.save_data(self.compute_instances_file, all_data)
        return False
    
    # ====================== IAM Operations ======================
    
    def list_service_accounts(self, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List IAM service accounts, optionally filtered by project"""
        data = self.json_db.load_data(self.iam_service_accounts_file)
        accounts = list(data.values()) if isinstance(data, dict) else []
        
        if project_id:
            accounts = [a for a in accounts if a.get('projectId') == project_id]
        
        return accounts
    
    def get_service_account(self, email: str) -> Optional[Dict[str, Any]]:
        """Get a specific IAM service account"""
        data = self.json_db.load_data(self.iam_service_accounts_file)
        return data.get(email) if isinstance(data, dict) else None
    
    def create_service_account(self, email: str, account_info: Dict[str, Any]) -> bool:
        """Create a new IAM service account"""
        all_data = self.json_db.load_data(self.iam_service_accounts_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        account_info.update({
            'email': email,
            'disabled': False,
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        })
        
        all_data[email] = account_info
        return self.json_db.save_data(self.iam_service_accounts_file, all_data)
    
    def delete_service_account(self, email: str) -> bool:
        """Delete an IAM service account"""
        all_data = self.json_db.load_data(self.iam_service_accounts_file)
        if isinstance(all_data, dict) and email in all_data:
            del all_data[email]
            return self.json_db.save_data(self.iam_service_accounts_file, all_data)
        return False
    
    def add_service_account_role(self, email: str, role: str) -> bool:
        """Add a role to a service account"""
        all_data = self.json_db.load_data(self.iam_service_accounts_file)
        if isinstance(all_data, dict) and email in all_data:
            if 'roles' not in all_data[email]:
                all_data[email]['roles'] = []
            if role not in all_data[email]['roles']:
                all_data[email]['roles'].append(role)
            return self.json_db.save_data(self.iam_service_accounts_file, all_data)
        return False
    
    def remove_service_account_role(self, email: str, role: str) -> bool:
        """Remove a role from a service account"""
        all_data = self.json_db.load_data(self.iam_service_accounts_file)
        if isinstance(all_data, dict) and email in all_data:
            if 'roles' in all_data[email] and role in all_data[email]['roles']:
                all_data[email]['roles'].remove(role)
            return self.json_db.save_data(self.iam_service_accounts_file, all_data)
        return False
    
    # ====================== Cloud Logging Operations ======================
    
    def write_log_entry(self, log_name: str, entry_data: Dict[str, Any]) -> bool:
        """Write a log entry to Cloud Logging
        
        Args:
            log_name: Name of the log
            entry_data: Log entry data (timestamp, severity, message, etc.)
            
        Returns:
            True if successfully written
        """
        import hashlib
        
        all_data = self.json_db.load_data(self.log_entries_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        # Generate unique entry ID
        timestamp = entry_data.get('timestamp', datetime.now(timezone.utc).isoformat())
        message = str(entry_data.get('text_payload') or entry_data.get('json_payload') or '')
        entry_id = hashlib.md5(f"{timestamp}{log_name}{message}".encode()).hexdigest()[:16]
        
        key = f"{log_name}:{entry_id}"
        
        entry_data.update({
            'log_name': log_name,
            'entry_id': entry_id,
            'timestamp': timestamp,
            'insert_time': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        })
        
        all_data[key] = entry_data
        return self.json_db.save_data(self.log_entries_file, all_data)
    
    def list_log_entries(self, filter_string: Optional[str] = None, 
                         max_results: int = 100) -> List[Dict[str, Any]]:
        """List log entries with optional filtering
        
        Args:
            filter_string: Filter string (simplified version of Cloud Logging filters)
            max_results: Maximum number of results to return
            
        Returns:
            List of log entries
        """
        data = self.json_db.load_data(self.log_entries_file)
        entries = list(data.values()) if isinstance(data, dict) else []
        
        # Apply filtering
        if filter_string:
            filtered_entries = []
            for entry in entries:
                if self._matches_log_filter(entry, filter_string):
                    filtered_entries.append(entry)
            entries = filtered_entries
        
        # Sort by timestamp (most recent first)
        entries.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        
        # Limit results
        return entries[:max_results]
    
    def _matches_log_filter(self, entry: Dict[str, Any], filter_string: str) -> bool:
        """Check if a log entry matches the filter string
        
        Simplified filter matching that supports:
        - log_name filtering: logName="exam_log"
        - severity filtering: severity="WARNING"
        - JSON payload filtering: jsonPayload.warning_level="CRITICAL"
        - timestamp filtering: timestamp>="2024-01-01T00:00:00Z"
        """
        import re
        
        filter_string = filter_string.strip()
        
        # Handle log_name filter
        if 'logName' in filter_string or 'log_name' in filter_string:
            match = re.search(r'log[Nn]ame\s*=\s*["\']([^"\']+)["\']', filter_string)
            if match:
                expected_log = match.group(1)
                if expected_log not in entry.get('log_name', ''):
                    return False
        
        # Handle severity filter
        if 'severity' in filter_string:
            match = re.search(r'severity\s*(=|>=|>)\s*["\']([^"\']+)["\']', filter_string)
            if match:
                operator = match.group(1)
                expected_severity = match.group(2).upper()
                entry_severity = entry.get('severity', 'INFO').upper()
                
                severity_levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
                
                if operator == '=':
                    if entry_severity != expected_severity:
                        return False
                elif operator in ['>=', '>']:
                    try:
                        entry_level = severity_levels.index(entry_severity)
                        expected_level = severity_levels.index(expected_severity)
                        if operator == '>=' and entry_level < expected_level:
                            return False
                        elif operator == '>' and entry_level <= expected_level:
                            return False
                    except ValueError:
                        return False
        
        # Handle JSON payload field filtering
        if 'jsonPayload.' in filter_string:
            match = re.search(r'jsonPayload\.(\w+)\s*=\s*["\']([^"\']+)["\']', filter_string)
            if match:
                field_name = match.group(1)
                expected_value = match.group(2)
                json_payload = entry.get('json_payload', {})
                
                if isinstance(json_payload, dict):
                    actual_value = json_payload.get(field_name)
                    if str(actual_value) != expected_value:
                        return False
        
        # Handle timestamp filter
        if 'timestamp' in filter_string:
            match = re.search(r'timestamp\s*(>=|>|<=|<)\s*["\']([^"\']+)["\']', filter_string)
            if match:
                operator = match.group(1)
                expected_time = match.group(2)
                entry_time = entry.get('timestamp', '')
                
                if operator == '>=':
                    if entry_time < expected_time:
                        return False
                elif operator == '>':
                    if entry_time <= expected_time:
                        return False
                elif operator == '<=':
                    if entry_time > expected_time:
                        return False
                elif operator == '<':
                    if entry_time >= expected_time:
                        return False
        
        return True
    
    def delete_log(self, log_name: str) -> bool:
        """Delete all entries in a log
        
        Args:
            log_name: Name of the log to delete
            
        Returns:
            True if successfully deleted
        """
        all_data = self.json_db.load_data(self.log_entries_file)
        if not isinstance(all_data, dict):
            return False
        
        # Remove all entries for this log
        keys_to_delete = [key for key, entry in all_data.items() 
                          if entry.get('log_name') == log_name]
        
        for key in keys_to_delete:
            del all_data[key]
        
        return self.json_db.save_data(self.log_entries_file, all_data)
    
    def list_log_names(self) -> List[str]:
        """List all unique log names
        
        Returns:
            List of log names
        """
        data = self.json_db.load_data(self.log_entries_file)
        entries = list(data.values()) if isinstance(data, dict) else []
        
        log_names = set(entry.get('log_name') for entry in entries if entry.get('log_name'))
        return sorted(list(log_names))
    
    def list_log_buckets(self) -> List[Dict[str, Any]]:
        """List all log buckets
        
        Returns:
            List of log buckets
        """
        data = self.json_db.load_data(self.log_buckets_file)
        return list(data.values()) if isinstance(data, dict) else []
    
    def get_log_bucket(self, bucket_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific log bucket
        
        Args:
            bucket_id: ID of the log bucket
            
        Returns:
            Log bucket data or None
        """
        data = self.json_db.load_data(self.log_buckets_file)
        return data.get(bucket_id) if isinstance(data, dict) else None
    
    def create_log_bucket(self, bucket_id: str, bucket_info: Dict[str, Any]) -> bool:
        """Create a new log bucket
        
        Args:
            bucket_id: ID for the new log bucket
            bucket_info: Bucket configuration (retention_days, description, etc.)
            
        Returns:
            True if successfully created
        """
        all_data = self.json_db.load_data(self.log_buckets_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        bucket_info.update({
            'bucket_id': bucket_id,
            'name': f"projects/local-project/locations/global/buckets/{bucket_id}",
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'updated': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'lifecycle_state': 'ACTIVE',
            'locked': bucket_info.get('locked', False)
        })
        
        all_data[bucket_id] = bucket_info
        return self.json_db.save_data(self.log_buckets_file, all_data)
    
    def delete_log_bucket(self, bucket_id: str) -> bool:
        """Delete a log bucket
        
        Args:
            bucket_id: ID of the log bucket to delete
            
        Returns:
            True if successfully deleted
        """
        all_data = self.json_db.load_data(self.log_buckets_file)
        if isinstance(all_data, dict) and bucket_id in all_data:
            # Check if bucket is locked
            if all_data[bucket_id].get('locked', False):
                raise ValueError(f"Cannot delete locked bucket: {bucket_id}")
            
            del all_data[bucket_id]
            return self.json_db.save_data(self.log_buckets_file, all_data)
        return False
    
    def list_log_sinks(self) -> List[Dict[str, Any]]:
        """List all log sinks
        
        Returns:
            List of log sinks
        """
        data = self.json_db.load_data(self.log_sinks_file)
        return list(data.values()) if isinstance(data, dict) else []
    
    def get_log_sink(self, sink_name: str) -> Optional[Dict[str, Any]]:
        """Get a specific log sink
        
        Args:
            sink_name: Name of the log sink
            
        Returns:
            Log sink data or None
        """
        data = self.json_db.load_data(self.log_sinks_file)
        return data.get(sink_name) if isinstance(data, dict) else None
    
    def create_log_sink(self, sink_name: str, sink_info: Dict[str, Any]) -> bool:
        """Create a new log sink
        
        Args:
            sink_name: Name for the new sink
            sink_info: Sink configuration (destination, filter, etc.)
            
        Returns:
            True if successfully created
        """
        all_data = self.json_db.load_data(self.log_sinks_file)
        if not isinstance(all_data, dict):
            all_data = {}
        
        sink_info.update({
            'name': sink_name,
            'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'updated': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'writer_identity': f"serviceAccount:cloud-logs@local-project.iam.gserviceaccount.com"
        })
        
        all_data[sink_name] = sink_info
        return self.json_db.save_data(self.log_sinks_file, all_data)
    
    def delete_log_sink(self, sink_name: str) -> bool:
        """Delete a log sink
        
        Args:
            sink_name: Name of the log sink to delete
            
        Returns:
            True if successfully deleted
        """
        all_data = self.json_db.load_data(self.log_sinks_file)
        if isinstance(all_data, dict) and sink_name in all_data:
            del all_data[sink_name]
            return self.json_db.save_data(self.log_sinks_file, all_data)
        return False
    
    # ====================== Utility Methods ======================
    
    def get_database_stats(self) -> Dict[str, Any]:
        """Get database statistics"""
        stats = {
            'bigquery_datasets': len(self.list_bigquery_datasets()),
            'bigquery_tables': len(self.json_db.load_data(self.bigquery_tables_file)),
            'storage_buckets': len(self.list_storage_buckets()),
            'storage_objects': len(self.json_db.load_data(self.storage_objects_file)),
            'compute_instances': len(self.list_compute_instances()),
            'service_accounts': len(self.list_service_accounts()),
            'log_entries': len(self.json_db.load_data(self.log_entries_file)),
            'log_buckets': len(self.list_log_buckets()),
            'log_sinks': len(self.list_log_sinks())
        }
        
        return stats
