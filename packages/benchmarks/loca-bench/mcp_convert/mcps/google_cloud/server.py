#!/usr/bin/env python3
"""
Google Cloud MCP Server

A Model Context Protocol server that provides Google Cloud Platform functionality
(BigQuery, Cloud Storage, Compute Engine, IAM) using local JSON files as the 
database instead of connecting to external APIs.

Uses the common MCP framework for simplified development.
"""

import asyncio
import sys
import os

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.mcp.server_base import BaseMCPServer
from common.mcp.tools import ToolRegistry, create_simple_tool_schema

# Import from same directory
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)
from database_utils import GoogleCloudDatabase


class GoogleCloudMCPServer(BaseMCPServer):
    """Google Cloud MCP server implementation"""
    
    def __init__(self):
        super().__init__("google-cloud", "1.0.0")
        
        # Determine data directory based on environment or default
        data_dir = self._get_data_directory()
        self.db = GoogleCloudDatabase(data_dir=data_dir)
        self.tool_registry = ToolRegistry()
        self.setup_tools()
    
    def _get_data_directory(self):
        """Determine the appropriate data directory for Google Cloud database"""
        import sys
        
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')

        # Priority 1: Environment variable (set by preprocess script or MCP config)
        env_dir = os.environ.get('GOOGLE_CLOUD_DATA_DIR')
        if env_dir:
            # Expand any variables or ~
            env_dir = os.path.expandvars(os.path.expanduser(env_dir))
            # Create directory if parent exists
            parent_dir = os.path.dirname(env_dir)
            if os.path.exists(parent_dir) or parent_dir == '':
                os.makedirs(env_dir, exist_ok=True)
                if not quiet:
                    print(f"[Google Cloud] Using data directory from env: {env_dir}", file=sys.stderr)
                return env_dir

        # Priority 2: Check for workspace-relative local_db
        # Look for ../local_db/google_cloud relative to current working directory
        cwd = os.getcwd()
        workspace_db = os.path.normpath(os.path.join(cwd, '..', 'local_db', 'google_cloud'))
        parent_local_db = os.path.dirname(workspace_db)

        # Check if we're in a workspace (has parent with local_db potential)
        if os.path.exists(parent_local_db) or 'workspace' in cwd.lower():
            os.makedirs(workspace_db, exist_ok=True)
            if not quiet:
                print(f"[Google Cloud] Using workspace-relative data directory: {workspace_db}", file=sys.stderr)
            return workspace_db

        # Priority 3: Default to package data directory
        default_dir = os.path.join(current_dir, "data")
        os.makedirs(default_dir, exist_ok=True)
        if not quiet:
            print(f"[Google Cloud] Using default data directory: {default_dir}", file=sys.stderr)
        return default_dir
    
    def setup_tools(self):
        """Setup all Google Cloud tools"""
        
        # ==================== BigQuery Tools ====================
        
        self.tool_registry.register(
            name="bigquery_run_query",
            description="Execute a BigQuery SQL query",
            input_schema=create_simple_tool_schema(
                required_params=["query"],
                optional_params={
                    "dry_run": {"type": "boolean", "description": "If True, only validate query without running it", "default": False},
                    "max_results": {"type": "integer", "description": "Maximum number of results to return (default: 1000)", "default": 1000}
                }
            ),
            handler=self.bigquery_run_query
        )
        
        self.tool_registry.register(
            name="bigquery_list_datasets",
            description="List all BigQuery datasets in the project",
            input_schema=create_simple_tool_schema([]),
            handler=self.bigquery_list_datasets
        )
        
        self.tool_registry.register(
            name="bigquery_create_dataset",
            description="Create a new BigQuery dataset",
            input_schema=create_simple_tool_schema(
                required_params=["dataset_id"],
                optional_params={
                    "description": {"type": "string", "description": "Optional description for the dataset", "default": ""},
                    "location": {"type": "string", "description": "Dataset location (default: US)", "default": "US"}
                }
            ),
            handler=self.bigquery_create_dataset
        )
        
        self.tool_registry.register(
            name="bigquery_get_dataset_info",
            description="Get detailed information about a BigQuery dataset",
            input_schema=create_simple_tool_schema(
                required_params=["dataset_id"]
            ),
            handler=self.bigquery_get_dataset_info
        )
        
        self.tool_registry.register(
            name="bigquery_load_csv_data",
            description="Load data from CSV file to BigQuery table",
            input_schema=create_simple_tool_schema(
                required_params=["dataset_id", "table_id", "csv_file_path"],
                optional_params={
                    "skip_header": {"type": "boolean", "description": "Whether to skip the first row (header)", "default": True},
                    "write_mode": {"type": "string", "description": "Write mode (WRITE_TRUNCATE, WRITE_APPEND, WRITE_EMPTY)", "default": "WRITE_TRUNCATE"}
                }
            ),
            handler=self.bigquery_load_csv_data
        )
        
        self.tool_registry.register(
            name="bigquery_export_table",
            description="Export BigQuery table to Cloud Storage",
            input_schema=create_simple_tool_schema(
                required_params=["dataset_id", "table_id", "destination_bucket", "destination_path"],
                optional_params={
                    "file_format": {"type": "string", "description": "Export format (CSV, JSON, AVRO)", "default": "CSV"}
                }
            ),
            handler=self.bigquery_export_table
        )
        
        self.tool_registry.register(
            name="bigquery_list_jobs",
            description="List BigQuery jobs",
            input_schema=create_simple_tool_schema(
                [],
                optional_params={
                    "max_results": {"type": "integer", "description": "Maximum number of jobs to return", "default": 50},
                    "state_filter": {"type": "string", "description": "Filter by job state (RUNNING, DONE, PENDING)", "default": ""}
                }
            ),
            handler=self.bigquery_list_jobs
        )
        
        self.tool_registry.register(
            name="bigquery_cancel_job",
            description="Cancel a BigQuery job",
            input_schema=create_simple_tool_schema(
                required_params=["job_id"]
            ),
            handler=self.bigquery_cancel_job
        )
        
        # ==================== Cloud Storage Tools ====================
        
        self.tool_registry.register(
            name="storage_list_buckets",
            description="List all Cloud Storage buckets",
            input_schema=create_simple_tool_schema([]),
            handler=self.storage_list_buckets
        )
        
        self.tool_registry.register(
            name="storage_create_bucket",
            description="Create a new Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name"],
                optional_params={
                    "location": {"type": "string", "description": "Location for the bucket (default: US)", "default": "US"}
                }
            ),
            handler=self.storage_create_bucket
        )
        
        self.tool_registry.register(
            name="storage_list_objects",
            description="List objects in a Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name"],
                optional_params={
                    "prefix": {"type": "string", "description": "Optional prefix to filter objects", "default": ""}
                }
            ),
            handler=self.storage_list_objects
        )
        
        self.tool_registry.register(
            name="storage_upload_file",
            description="Upload a file to Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name", "source_file_path", "destination_blob_name"]
            ),
            handler=self.storage_upload_file
        )
        
        self.tool_registry.register(
            name="storage_download_file",
            description="Download a file from Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name", "source_blob_name", "destination_file_path"]
            ),
            handler=self.storage_download_file
        )
        
        self.tool_registry.register(
            name="storage_delete_object",
            description="Delete an object from Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name", "blob_name"]
            ),
            handler=self.storage_delete_object
        )
        
        self.tool_registry.register(
            name="storage_get_bucket_info",
            description="Get detailed information about a Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name"]
            ),
            handler=self.storage_get_bucket_info
        )
        
        self.tool_registry.register(
            name="storage_generate_signed_url",
            description="Generate a signed URL for temporary access to a Cloud Storage object",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name", "blob_name"],
                optional_params={
                    "expiration_minutes": {"type": "integer", "description": "URL expiration time in minutes (default: 60)", "default": 60},
                    "method": {"type": "string", "description": "HTTP method (GET, PUT, POST, DELETE)", "default": "GET"}
                }
            ),
            handler=self.storage_generate_signed_url
        )
        
        self.tool_registry.register(
            name="storage_copy_object",
            description="Copy an object between Cloud Storage buckets",
            input_schema=create_simple_tool_schema(
                required_params=["source_bucket", "source_blob", "dest_bucket", "dest_blob"]
            ),
            handler=self.storage_copy_object
        )
        
        self.tool_registry.register(
            name="storage_move_object",
            description="Move an object between Cloud Storage buckets",
            input_schema=create_simple_tool_schema(
                required_params=["source_bucket", "source_blob", "dest_bucket", "dest_blob"]
            ),
            handler=self.storage_move_object
        )
        
        self.tool_registry.register(
            name="storage_enable_versioning",
            description="Enable or disable versioning for a Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name"],
                optional_params={
                    "enabled": {"type": "boolean", "description": "Whether to enable (True) or disable (False) versioning", "default": True}
                }
            ),
            handler=self.storage_enable_versioning
        )
        
        self.tool_registry.register(
            name="storage_get_bucket_size",
            description="Get size statistics for a Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name"]
            ),
            handler=self.storage_get_bucket_size
        )
        
        self.tool_registry.register(
            name="storage_set_bucket_lifecycle",
            description="Set lifecycle rules for a Cloud Storage bucket",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_name"],
                optional_params={
                    "age_days": {"type": "integer", "description": "Age in days after which to apply the action", "default": 30},
                    "action": {"type": "string", "description": "Action to take (Delete, SetStorageClass)", "default": "Delete"}
                }
            ),
            handler=self.storage_set_bucket_lifecycle
        )
        
        # ==================== Compute Engine Tools ====================
        
        self.tool_registry.register(
            name="compute_list_instances",
            description="List Compute Engine instances",
            input_schema=create_simple_tool_schema(
                [],
                optional_params={
                    "zone": {"type": "string", "description": "Optional zone filter, if empty lists from all zones", "default": ""}
                }
            ),
            handler=self.compute_list_instances
        )
        
        self.tool_registry.register(
            name="compute_create_instance",
            description="Create a new Compute Engine instance",
            input_schema=create_simple_tool_schema(
                required_params=["instance_name", "zone"],
                optional_params={
                    "machine_type": {"type": "string", "description": "Machine type (default: e2-micro)", "default": "e2-micro"}
                }
            ),
            handler=self.compute_create_instance
        )
        
        self.tool_registry.register(
            name="compute_delete_instance",
            description="Delete a Compute Engine instance",
            input_schema=create_simple_tool_schema(
                required_params=["instance_name", "zone"]
            ),
            handler=self.compute_delete_instance
        )
        
        self.tool_registry.register(
            name="compute_start_instance",
            description="Start a Compute Engine instance",
            input_schema=create_simple_tool_schema(
                required_params=["instance_name", "zone"]
            ),
            handler=self.compute_start_instance
        )
        
        self.tool_registry.register(
            name="compute_stop_instance",
            description="Stop a Compute Engine instance",
            input_schema=create_simple_tool_schema(
                required_params=["instance_name", "zone"]
            ),
            handler=self.compute_stop_instance
        )
        
        self.tool_registry.register(
            name="compute_restart_instance",
            description="Restart a Compute Engine instance",
            input_schema=create_simple_tool_schema(
                required_params=["instance_name", "zone"]
            ),
            handler=self.compute_restart_instance
        )
        
        self.tool_registry.register(
            name="compute_get_instance",
            description="Get detailed information about a Compute Engine instance",
            input_schema=create_simple_tool_schema(
                required_params=["instance_name", "zone"]
            ),
            handler=self.compute_get_instance
        )
        
        self.tool_registry.register(
            name="compute_list_zones",
            description="List all available Compute Engine zones",
            input_schema=create_simple_tool_schema([]),
            handler=self.compute_list_zones
        )
        
        self.tool_registry.register(
            name="compute_wait_for_operation",
            description="Wait for a Compute Engine operation to complete",
            input_schema=create_simple_tool_schema(
                required_params=["operation_name", "zone"],
                optional_params={
                    "timeout_minutes": {"type": "integer", "description": "Maximum time to wait in minutes (default: 5)", "default": 5}
                }
            ),
            handler=self.compute_wait_for_operation
        )
        
        # ==================== Cloud Logging Tools ====================
        
        self.tool_registry.register(
            name="logging_write_log",
            description="Write a log entry to Cloud Logging",
            input_schema=create_simple_tool_schema(
                required_params=["log_name", "message"],
                optional_params={
                    "severity": {"type": "string", "description": "Log severity (DEBUG, INFO, WARNING, ERROR, CRITICAL)", "default": "INFO"}
                }
            ),
            handler=self.logging_write_log
        )
        
        self.tool_registry.register(
            name="logging_read_logs",
            description="Read recent log entries from Cloud Logging",
            input_schema=create_simple_tool_schema(
                [],
                optional_params={
                    "log_filter": {"type": "string", "description": "Optional filter for log entries", "default": ""},
                    "max_entries": {"type": "integer", "description": "Maximum number of entries to return (default: 50)", "default": 50}
                }
            ),
            handler=self.logging_read_logs
        )
        
        self.tool_registry.register(
            name="logging_list_logs",
            description="List all log names in the project",
            input_schema=create_simple_tool_schema([]),
            handler=self.logging_list_logs
        )
        
        self.tool_registry.register(
            name="logging_delete_log",
            description="Delete a log",
            input_schema=create_simple_tool_schema(
                required_params=["log_name"]
            ),
            handler=self.logging_delete_log
        )
        
        self.tool_registry.register(
            name="logging_create_log_bucket",
            description="Create a log bucket for storing logs",
            input_schema=create_simple_tool_schema(
                required_params=["bucket_id"],
                optional_params={
                    "location": {"type": "string", "description": "Location for the bucket (default: global)", "default": "global"},
                    "retention_days": {"type": "integer", "description": "Log retention period in days (default: 30)", "default": 30}
                }
            ),
            handler=self.logging_create_log_bucket
        )
        
        self.tool_registry.register(
            name="logging_list_log_buckets",
            description="List all log buckets in the project",
            input_schema=create_simple_tool_schema([]),
            handler=self.logging_list_log_buckets
        )
        
        self.tool_registry.register(
            name="logging_create_log_sink",
            description="Create a log sink to export logs to another service",
            input_schema=create_simple_tool_schema(
                required_params=["sink_name", "destination"],
                optional_params={
                    "log_filter": {"type": "string", "description": "Optional filter for which logs to export", "default": ""}
                }
            ),
            handler=self.logging_create_log_sink
        )
        
        self.tool_registry.register(
            name="logging_list_log_sinks",
            description="List all log sinks in the project",
            input_schema=create_simple_tool_schema([]),
            handler=self.logging_list_log_sinks
        )
        
        self.tool_registry.register(
            name="logging_delete_log_sink",
            description="Delete a log sink",
            input_schema=create_simple_tool_schema(
                required_params=["sink_name"]
            ),
            handler=self.logging_delete_log_sink
        )
    
    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()
    
    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        return await self.tool_registry.call_tool(name, arguments)
    
    # ==================== BigQuery Handlers ====================
    
    async def bigquery_run_query(self, args: dict):
        """Execute a BigQuery SQL query"""
        query = args["query"]
        dry_run = args.get("dry_run", False)
        max_results = args.get("max_results", 1000)
        
        # Execute real query against local database
        result = self.db.run_bigquery_query(query)
        
        # Format response like real Google Cloud API
        if result['status'] == 'ERROR':
            return self.create_text_response(f"Error executing query: {result.get('error', 'Unknown error')}")
        
        rows = result['results'][:max_results] if max_results else result['results']
        
        response = f"Query executed successfully\n"
        response += f"Total rows: {result['totalRows']}\n"
        response += f"Execution time: {result['duration_ms']}ms\n"
        
        if rows:
            response += f"\nResults (showing {len(rows)} rows):\n"
            import json
            response += json.dumps(rows, indent=2, ensure_ascii=False)
        else:
            response += "\nNo results returned"
        
        return self.create_text_response(response)
    
    async def bigquery_list_datasets(self, args: dict):
        """List all BigQuery datasets in the project"""
        datasets = self.db.list_bigquery_datasets()
        
        if not datasets:
            return self.create_text_response("No datasets found or no access to allowed datasets")
        
        response = f"Found {len(datasets)} datasets:\n"
        response += "\n".join([f"- {ds['datasetId']} (Project: {ds['projectId']})" for ds in datasets])
        return self.create_text_response(response)
    
    async def bigquery_create_dataset(self, args: dict):
        """Create a new BigQuery dataset"""
        dataset_id = args["dataset_id"]
        description = args.get("description", "")
        location = args.get("location", "US")
        
        # Since this is local, we need to extract project_id from somewhere
        # For simplicity, use "local-project"
        project_id = "local-project"
        
        dataset_info = {
            "location": location,
            "description": description,
            "labels": {}
        }
        
        success = self.db.create_bigquery_dataset(project_id, dataset_id, dataset_info)
        
        if success:
            return self.create_text_response(f"Successfully created dataset '{dataset_id}' in location '{location}'")
        else:
            return self.create_text_response(f"Error creating BigQuery dataset: {dataset_id}")
    
    async def bigquery_get_dataset_info(self, args: dict):
        """Get detailed information about a BigQuery dataset"""
        dataset_id = args["dataset_id"]
        
        # Try to find dataset with any project
        datasets = self.db.list_bigquery_datasets()
        dataset = next((d for d in datasets if d.get('datasetId') == dataset_id), None)
        
        if not dataset:
            return self.create_text_response(f"Error getting dataset info for '{dataset_id}': Dataset not found")
        
        result = f"Dataset Information for '{dataset_id}':\n"
        result += f"Full Name: {dataset.get('projectId', 'unknown')}.{dataset['datasetId']}\n"
        result += f"Location: {dataset.get('location', 'Unknown')}\n"
        result += f"Description: {dataset.get('description', 'No description')}\n"
        result += f"Created: {dataset.get('created', 'Unknown')}\n"
        result += f"Modified: {dataset.get('modified', 'Unknown')}\n"
        result += f"Labels: {dataset.get('labels', {}) or 'None'}"
        
        return self.create_text_response(result)
    
    async def bigquery_load_csv_data(self, args: dict):
        """Load data from CSV file to BigQuery table"""
        dataset_id = args["dataset_id"]
        table_id = args["table_id"]
        csv_file_path = args["csv_file_path"]
        skip_header = args.get("skip_header", True)
        write_mode = args.get("write_mode", "WRITE_TRUNCATE")
        
        # Read CSV file
        try:
            import csv
            import os
            
            if not os.path.exists(csv_file_path):
                return self.create_text_response(f"Error: CSV file not found: {csv_file_path}")
            
            # Read CSV data
            rows = []
            with open(csv_file_path, 'r', encoding='utf-8') as f:
                csv_reader = csv.DictReader(f) if skip_header else csv.reader(f)
                
                if skip_header:
                    # Using DictReader, each row is a dictionary
                    for row in csv_reader:
                        rows.append(row)
                else:
                    # Using regular reader, need to get header manually
                    all_rows = list(csv_reader)
                    if not all_rows:
                        return self.create_text_response("Error: CSV file is empty")
                    
                    header = all_rows[0]
                    for row in all_rows:
                        rows.append(dict(zip(header, row)))
            
            if not rows:
                return self.create_text_response("Error: No data rows found in CSV file")
            
            # Get table to verify it exists and get schema
            project_id = "local-project"  # Default project ID
            
            # Find the full table reference
            tables = self.db.list_bigquery_tables(project_id, dataset_id)
            table_exists = any(t.get('tableId') == table_id for t in tables)
            
            if not table_exists:
                return self.create_text_response(f"Error: Table '{dataset_id}.{table_id}' does not exist")
            
            # Handle write mode
            if write_mode == "WRITE_TRUNCATE":
                # Clear existing data by deleting and recreating table
                table_info = self.db.get_bigquery_table(project_id, dataset_id, table_id)
                if table_info:
                    self.db.delete_bigquery_table(project_id, dataset_id, table_id)
                    self.db.create_bigquery_table(project_id, dataset_id, table_id, {
                        "schema": table_info.get("schema", []),
                        "description": table_info.get("description", "")
                    })
            elif write_mode == "WRITE_EMPTY":
                # Check if table has data
                query = f"SELECT COUNT(*) as count FROM `{project_id}.{dataset_id}.{table_id}`"
                result = self.db.run_bigquery_query(query)
                if result.get('status') == 'DONE' and result.get('results'):
                    count = result['results'][0].get('count', 0)
                    if count > 0:
                        return self.create_text_response(f"Error: Table '{dataset_id}.{table_id}' already contains data (WRITE_EMPTY mode)")
            
            # Insert rows
            success = self.db.insert_table_rows(project_id, dataset_id, table_id, rows)
            
            if success:
                return self.create_text_response(
                    f"Successfully loaded {len(rows)} rows from '{csv_file_path}' to table '{dataset_id}.{table_id}'\n"
                    f"Write mode: {write_mode}"
                )
            else:
                return self.create_text_response(f"Error inserting data into table '{dataset_id}.{table_id}'")
                
        except Exception as e:
            import traceback
            error_msg = f"Error loading CSV data: {str(e)}\n{traceback.format_exc()}"
            return self.create_text_response(error_msg)
    
    async def bigquery_export_table(self, args: dict):
        """Export BigQuery table to Cloud Storage"""
        dataset_id = args["dataset_id"]
        table_id = args["table_id"]
        destination_bucket = args["destination_bucket"]
        destination_path = args["destination_path"]
        file_format = args.get("file_format", "CSV")
        
        destination_uri = f"gs://{destination_bucket}/{destination_path}"
        return self.create_text_response(f"Successfully exported table '{dataset_id}.{table_id}' to '{destination_uri}'")
    
    async def bigquery_list_jobs(self, args: dict):
        """List BigQuery jobs"""
        max_results = args.get("max_results", 50)
        state_filter = args.get("state_filter", "")
        
        return self.create_text_response("No BigQuery jobs found")
    
    async def bigquery_cancel_job(self, args: dict):
        """Cancel a BigQuery job"""
        job_id = args["job_id"]
        
        return self.create_text_response(f"Successfully cancelled BigQuery job '{job_id}'")
    
    # ==================== Cloud Storage Handlers ====================
    
    async def storage_list_buckets(self, args: dict):
        """List all Cloud Storage buckets"""
        buckets = self.db.list_storage_buckets()
        
        response = f"Found {len(buckets)} buckets:\n"
        response += "\n".join([f"- {b['name']}: {b.get('location', 'Unknown location')}" for b in buckets])
        return self.create_text_response(response)
    
    async def storage_create_bucket(self, args: dict):
        """Create a new Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        location = args.get("location", "US")
        
        bucket_info = {
            "location": location,
            "storageClass": "STANDARD",
            "labels": {}
        }
        
        success = self.db.create_storage_bucket(bucket_name, bucket_info)
        
        if success:
            return self.create_text_response(f"Successfully created bucket '{bucket_name}' in location '{location}'")
        else:
            return self.create_text_response(f"Error creating Cloud Storage bucket: {bucket_name}")
    
    async def storage_list_objects(self, args: dict):
        """List objects in a Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        prefix = args.get("prefix", "")
        
        objects = self.db.list_storage_objects(bucket_name, prefix if prefix else None)
        
        response = f"Found {len(objects)} objects in bucket '{bucket_name}':\n"
        response += "\n".join([f"- {obj['name']}: {obj.get('size', 0)} bytes" for obj in objects[:20]])
        if len(objects) > 20:
            response += "\n..."
        return self.create_text_response(response)
    
    async def storage_upload_file(self, args: dict):
        """Upload a file to Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        source_file_path = args["source_file_path"]
        destination_blob_name = args["destination_blob_name"]
        
        # Read file content
        try:
            with open(source_file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            content_type = "text/plain"
        except UnicodeDecodeError:
            # If not text, read as binary and encode to base64 for storage
            with open(source_file_path, 'rb') as f:
                import base64
                content = base64.b64encode(f.read()).decode('utf-8')
            content_type = "application/octet-stream"
        except FileNotFoundError:
            return self.create_text_response(f"Error: File '{source_file_path}' not found")
        except Exception as e:
            return self.create_text_response(f"Error reading file '{source_file_path}': {str(e)}")
        
        object_info = {
            "contentType": content_type,
            "size": len(content),
            "metadata": {},
            "content": content
        }
        
        try:
            success = self.db.upload_storage_object(bucket_name, destination_blob_name, object_info)
        except ValueError as e:
            return self.create_text_response(f"Error: {str(e)}")

        if success:
            return self.create_text_response(f"Successfully uploaded '{source_file_path}' to '{bucket_name}/{destination_blob_name}'")
        else:
            return self.create_text_response(f"Error uploading file to bucket '{bucket_name}'")
    
    async def storage_download_file(self, args: dict):
        """Download a file from Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        source_blob_name = args["source_blob_name"]
        destination_file_path = args["destination_file_path"]
        
        obj = self.db.get_storage_object(bucket_name, source_blob_name)
        
        if not obj:
            return self.create_text_response(f"Error downloading file from bucket '{bucket_name}': Object not found")
        
        # Write content to file
        try:
            content = obj.get("content", "")
            content_type = obj.get("contentType", "application/octet-stream")
            
            if content_type == "application/octet-stream" and content:
                # Decode base64 for binary files
                import base64
                try:
                    with open(destination_file_path, 'wb') as f:
                        f.write(base64.b64decode(content))
                except:
                    # If not base64, write as text
                    with open(destination_file_path, 'w', encoding='utf-8') as f:
                        f.write(content)
            else:
                # Write as text
                with open(destination_file_path, 'w', encoding='utf-8') as f:
                    f.write(content)
            
            return self.create_text_response(f"Successfully downloaded '{bucket_name}/{source_blob_name}' to '{destination_file_path}'")
        except Exception as e:
            return self.create_text_response(f"Error writing file '{destination_file_path}': {str(e)}")
    
    async def storage_delete_object(self, args: dict):
        """Delete an object from Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        blob_name = args["blob_name"]
        
        success = self.db.delete_storage_object(bucket_name, blob_name)
        
        if success:
            return self.create_text_response(f"Successfully deleted '{blob_name}' from bucket '{bucket_name}'")
        else:
            return self.create_text_response(f"Object '{blob_name}' not found in bucket '{bucket_name}'")
    
    async def storage_get_bucket_info(self, args: dict):
        """Get detailed information about a Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        
        bucket = self.db.get_storage_bucket(bucket_name)
        
        if not bucket:
            return self.create_text_response(f"Error getting bucket info for '{bucket_name}': Bucket not found")
        
        result = f"Bucket Information for '{bucket_name}':\n"
        result += f"Location: {bucket.get('location', 'Unknown')}\n"
        result += f"Storage Class: {bucket.get('storageClass', 'Unknown')}\n"
        result += f"Created: {bucket.get('created', 'Unknown')}\n"
        result += f"Versioning: {'Enabled' if bucket.get('versioning', {}).get('enabled') else 'Disabled'}\n"
        result += f"Labels: {bucket.get('labels', {})}\n"
        
        lifecycle_rules = bucket.get('lifecycle', {}).get('rule', [])
        result += f"Lifecycle Rules: {len(lifecycle_rules)}"
        
        return self.create_text_response(result)
    
    async def storage_generate_signed_url(self, args: dict):
        """Generate a signed URL for temporary access to a Cloud Storage object"""
        bucket_name = args["bucket_name"]
        blob_name = args["blob_name"]
        expiration_minutes = args.get("expiration_minutes", 60)
        method = args.get("method", "GET")
        
        url = f"https://storage.googleapis.com/{bucket_name}/{blob_name}?signed_url_expires_in_{expiration_minutes}_minutes"
        return self.create_text_response(f"Signed URL for '{bucket_name}/{blob_name}' (expires in {expiration_minutes} minutes):\n{url}")
    
    async def storage_copy_object(self, args: dict):
        """Copy an object between Cloud Storage buckets"""
        source_bucket = args["source_bucket"]
        source_blob = args["source_blob"]
        dest_bucket = args["dest_bucket"]
        dest_blob = args["dest_blob"]
        
        # Get source object
        source_obj = self.db.get_storage_object(source_bucket, source_blob)

        if not source_obj:
            return self.create_text_response(f"Error copying object: Source object not found")

        # Copy to destination
        try:
            success = self.db.upload_storage_object(dest_bucket, dest_blob, source_obj.copy())
        except ValueError as e:
            return self.create_text_response(f"Error copying object: {str(e)}")

        if success:
            return self.create_text_response(f"Successfully copied '{source_bucket}/{source_blob}' to '{dest_bucket}/{dest_blob}'")
        else:
            return self.create_text_response(f"Error copying object")
    
    async def storage_move_object(self, args: dict):
        """Move an object between Cloud Storage buckets"""
        source_bucket = args["source_bucket"]
        source_blob = args["source_blob"]
        dest_bucket = args["dest_bucket"]
        dest_blob = args["dest_blob"]
        
        # Copy then delete
        await self.storage_copy_object(args)
        self.db.delete_storage_object(source_bucket, source_blob)
        
        return self.create_text_response(f"Successfully moved '{source_bucket}/{source_blob}' to '{dest_bucket}/{dest_blob}'")
    
    async def storage_enable_versioning(self, args: dict):
        """Enable or disable versioning for a Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        enabled = args.get("enabled", True)
        
        status = "enabled" if enabled else "disabled"
        return self.create_text_response(f"Successfully {status} versioning for bucket '{bucket_name}'")
    
    async def storage_get_bucket_size(self, args: dict):
        """Get size statistics for a Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        
        objects = self.db.list_storage_objects(bucket_name)
        total_size = sum(obj.get('size', 0) for obj in objects)
        
        result = f"Bucket Size Statistics for '{bucket_name}':\n"
        result += f"Total Objects: {len(objects)}\n"
        result += f"Total Size: {total_size} bytes\n"
        result += f"Size (MB): {total_size / (1024*1024):.2f} MB\n"
        result += f"Size (GB): {total_size / (1024*1024*1024):.2f} GB"
        
        return self.create_text_response(result)
    
    async def storage_set_bucket_lifecycle(self, args: dict):
        """Set lifecycle rules for a Cloud Storage bucket"""
        bucket_name = args["bucket_name"]
        age_days = args.get("age_days", 30)
        action = args.get("action", "Delete")
        
        return self.create_text_response(f"Successfully set lifecycle rule for bucket '{bucket_name}': {action} objects after {age_days} days")
    
    # ==================== Compute Engine Handlers ====================
    
    async def compute_list_instances(self, args: dict):
        """List Compute Engine instances"""
        zone = args.get("zone", "")
        
        instances = self.db.list_compute_instances(zone if zone else None)
        
        response = f"Found {len(instances)} instances:\n"
        response += "\n".join([f"- {inst['name']}: {inst.get('status', 'Unknown')} in {inst.get('zone', 'Unknown zone')}" for inst in instances])
        return self.create_text_response(response)
    
    async def compute_create_instance(self, args: dict):
        """Create a new Compute Engine instance"""
        instance_name = args["instance_name"]
        zone = args["zone"]
        machine_type = args.get("machine_type", "e2-micro")
        
        instance_info = {
            "zone": zone,
            "machineType": machine_type,
            "labels": {}
        }
        
        success = self.db.create_compute_instance(instance_name, instance_info)
        
        if success:
            return self.create_text_response(f"Successfully initiated creation of instance '{instance_name}' in zone '{zone}'")
        else:
            return self.create_text_response(f"Error creating Compute Engine instance: {instance_name}")
    
    async def compute_delete_instance(self, args: dict):
        """Delete a Compute Engine instance"""
        instance_name = args["instance_name"]
        zone = args["zone"]
        
        success = self.db.delete_compute_instance(instance_name)
        
        if success:
            return self.create_text_response(f"Successfully initiated deletion of instance '{instance_name}' in zone '{zone}'")
        else:
            return self.create_text_response(f"Error deleting Compute Engine instance: {instance_name}")
    
    async def compute_start_instance(self, args: dict):
        """Start a Compute Engine instance"""
        instance_name = args["instance_name"]
        zone = args["zone"]
        
        success = self.db.start_compute_instance(instance_name)
        
        if success:
            return self.create_text_response(f"Successfully initiated start of instance '{instance_name}' in zone '{zone}'")
        else:
            return self.create_text_response(f"Error starting Compute Engine instance: {instance_name}")
    
    async def compute_stop_instance(self, args: dict):
        """Stop a Compute Engine instance"""
        instance_name = args["instance_name"]
        zone = args["zone"]
        
        success = self.db.stop_compute_instance(instance_name)
        
        if success:
            return self.create_text_response(f"Successfully initiated stop of instance '{instance_name}' in zone '{zone}'")
        else:
            return self.create_text_response(f"Error stopping Compute Engine instance: {instance_name}")
    
    async def compute_restart_instance(self, args: dict):
        """Restart a Compute Engine instance"""
        instance_name = args["instance_name"]
        zone = args["zone"]
        
        # Stop then start
        self.db.stop_compute_instance(instance_name)
        self.db.start_compute_instance(instance_name)
        
        return self.create_text_response(f"Successfully initiated restart of instance '{instance_name}' in zone '{zone}'")
    
    async def compute_get_instance(self, args: dict):
        """Get detailed information about a Compute Engine instance"""
        instance_name = args["instance_name"]
        zone = args["zone"]
        
        instance = self.db.get_compute_instance(instance_name)
        
        if not instance:
            return self.create_text_response(f"Error getting instance info for '{instance_name}': Instance not found")
        
        result = f"Instance Information for '{instance_name}':\n"
        result += f"Status: {instance.get('status', 'Unknown')}\n"
        result += f"Zone: {instance.get('zone', 'Unknown')}\n"
        result += f"Machine Type: {instance.get('machineType', 'Unknown')}\n"
        result += f"Created: {instance.get('created', 'Unknown')}\n"
        
        network_interfaces = instance.get('networkInterfaces', [])
        if network_interfaces:
            ni = network_interfaces[0]
            result += f"Internal IP: {ni.get('networkIP', 'None')}\n"
            access_configs = ni.get('accessConfigs', [])
            if access_configs:
                result += f"External IP: {access_configs[0].get('natIP', 'None')}\n"
        
        disks = instance.get('disks', [])
        if disks:
            result += f"Boot Disk: {len(disks)} disk(s)\n"
        
        result += f"Network Tags: {instance.get('tags', [])}\n"
        result += f"Labels: {instance.get('labels', {})}"
        
        return self.create_text_response(result)
    
    async def compute_list_zones(self, args: dict):
        """List all available Compute Engine zones"""
        zones = ["us-central1-a", "us-central1-b", "us-east1-b", "us-west1-a", "europe-west1-b", "asia-east1-a"]
        
        response = f"Found {len(zones)} available zones:\n"
        response += "\n".join([f"- {zone}" for zone in zones])
        return self.create_text_response(response)
    
    async def compute_wait_for_operation(self, args: dict):
        """Wait for a Compute Engine operation to complete"""
        operation_name = args["operation_name"]
        zone = args["zone"]
        timeout_minutes = args.get("timeout_minutes", 5)
        
        return self.create_text_response(f"Operation '{operation_name}' completed successfully")
    
    # ==================== Cloud Logging Handlers ====================
    
    async def logging_write_log(self, args: dict):
        """Write a log entry to Cloud Logging
        
        Aligned with real Cloud Logging API behavior.
        """
        log_name = args["log_name"]
        message = args["message"]
        severity = args.get("severity", "INFO").upper()
        
        from datetime import datetime
        
        # Create log entry data
        entry_data = {
            "timestamp": datetime.now().isoformat(),
            "severity": severity,
            "resource": {
                "type": "global",
                "labels": {"project_id": "local-project"}
            }
        }
        
        # Support both text and structured logging
        if isinstance(message, str):
            entry_data["text_payload"] = message
        else:
            entry_data["json_payload"] = message
        
        # Write to log entries database
        success = self.db.write_log_entry(log_name, entry_data)
        
        if success:
            return self.create_text_response(f"Successfully wrote log entry to '{log_name}' with severity '{severity}'")
        else:
            return self.create_text_response(f"Error writing log to '{log_name}'")
    
    async def logging_read_logs(self, args: dict):
        """Read recent log entries from Cloud Logging
        
        Aligned with real Cloud Logging API behavior with filter support.
        """
        log_filter = args.get("log_filter", "")
        max_entries = args.get("max_entries", 50)
        
        import json
        
        # Use database method to list log entries with filtering
        entries = self.db.list_log_entries(
            filter_string=log_filter if log_filter else None,
            max_results=max_entries
        )
        
        if not entries:
            return self.create_text_response("No log entries found matching the filter criteria")
        
        result = f"Found {len(entries)} log entries:\n\n"
        for entry in entries:
            timestamp = entry.get('timestamp', 'Unknown')
            severity = entry.get('severity', 'INFO')
            log_name = entry.get('log_name', 'Unknown')
            
            # Get message from text_payload or json_payload
            text_msg = entry.get('text_payload')
            json_msg = entry.get('json_payload')
            
            if text_msg:
                message = str(text_msg)
            elif json_msg:
                message = json.dumps(json_msg) if isinstance(json_msg, dict) else str(json_msg)
            else:
                message = 'No message'
            
            # Truncate long messages
            if len(message) > 200:
                message = message[:200] + "..."
            
            result += f"[{timestamp}] {severity} - {log_name}:\n  {message}\n\n"
        
        return self.create_text_response(result)
    
    async def logging_list_logs(self, args: dict):
        """List all log names in the project
        
        Aligned with real Cloud Logging API behavior.
        """
        # List unique log names from log entries
        log_names = self.db.list_log_names()
        
        if not log_names:
            return self.create_text_response("No logs found")
        
        result = f"Found {len(log_names)} logs:\n"
        for log_name in log_names:
            result += f"- {log_name}\n"
        
        return self.create_text_response(result)
    
    async def logging_delete_log(self, args: dict):
        """Delete a log (all entries in the log)
        
        Aligned with real Cloud Logging API behavior.
        """
        log_name = args["log_name"]
        
        # Delete all log entries for this log name
        success = self.db.delete_log(log_name)
        
        if success:
            return self.create_text_response(f"Successfully deleted log '{log_name}'")
        else:
            return self.create_text_response(f"Log '{log_name}' not found or could not be deleted")
    
    async def logging_create_log_bucket(self, args: dict):
        """Create a log bucket for storing logs
        
        Aligned with real Cloud Logging API behavior.
        """
        bucket_id = args["bucket_id"]
        location = args.get("location", "global")
        retention_days = args.get("retention_days", 30)
        
        bucket_info = {
            "location": location,
            "retention_days": retention_days,
            "description": f"Log bucket: {bucket_id}"
        }
        
        try:
            success = self.db.create_log_bucket(bucket_id, bucket_info)
            
            if success:
                return self.create_text_response(
                    f"Successfully created log bucket '{bucket_id}' with {retention_days} days retention"
                )
            else:
                return self.create_text_response(f"Error creating log bucket '{bucket_id}'")
        except ValueError as e:
            return self.create_text_response(f"Error: {str(e)}")
    
    async def logging_list_log_buckets(self, args: dict):
        """List all log buckets in the project
        
        Aligned with real Cloud Logging API behavior.
        """
        buckets = self.db.list_log_buckets()
        
        if not buckets:
            return self.create_text_response("No log buckets found")
        
        result = f"Found {len(buckets)} log buckets:\n\n"
        for bucket in buckets:
            bucket_id = bucket.get('bucket_id', 'Unknown')
            retention = bucket.get('retention_days', 'N/A')
            location = bucket.get('location', 'Unknown')
            state = bucket.get('lifecycle_state', 'Unknown')
            locked = bucket.get('locked', False)
            
            result += f"- {bucket_id}\n"
            result += f"  Location: {location}\n"
            result += f"  Retention: {retention} days\n"
            result += f"  State: {state}\n"
            result += f"  Locked: {locked}\n\n"
        
        return self.create_text_response(result)
    
    async def logging_create_log_sink(self, args: dict):
        """Create a log sink to export logs to another service
        
        Aligned with real Cloud Logging API behavior.
        """
        sink_name = args["sink_name"]
        destination = args["destination"]
        log_filter = args.get("log_filter", "")
        
        sink_info = {
            "destination": destination,
            "filter": log_filter,
            "description": f"Log sink: {sink_name}",
            "disabled": False
        }
        
        success = self.db.create_log_sink(sink_name, sink_info)
        
        if success:
            writer_identity = f"serviceAccount:cloud-logs@local-project.iam.gserviceaccount.com"
            result = f"Successfully created log sink '{sink_name}'\n"
            result += f"Destination: {destination}\n"
            if log_filter:
                result += f"Filter: {log_filter}\n"
            result += f"Writer Identity: {writer_identity}\n"
            result += f"\nNote: Grant write access to the writer identity on the destination."
            return self.create_text_response(result)
        else:
            return self.create_text_response(f"Error creating log sink '{sink_name}'")
    
    async def logging_list_log_sinks(self, args: dict):
        """List all log sinks in the project
        
        Aligned with real Cloud Logging API behavior.
        """
        sinks = self.db.list_log_sinks()
        
        if not sinks:
            return self.create_text_response("No log sinks found")
        
        result = f"Found {len(sinks)} log sinks:\n\n"
        for sink in sinks:
            name = sink.get('name', 'Unknown')
            destination = sink.get('destination', 'Unknown')
            filter_str = sink.get('filter', 'None')
            disabled = sink.get('disabled', False)
            
            result += f"- {name}\n"
            result += f"  Destination: {destination}\n"
            result += f"  Filter: {filter_str}\n"
            result += f"  Disabled: {disabled}\n\n"
        
        return self.create_text_response(result)
    
    async def logging_delete_log_sink(self, args: dict):
        """Delete a log sink
        
        Aligned with real Cloud Logging API behavior.
        """
        sink_name = args["sink_name"]
        
        success = self.db.delete_log_sink(sink_name)
        
        if success:
            return self.create_text_response(f"Successfully deleted log sink '{sink_name}'")
        else:
            return self.create_text_response(f"Log sink '{sink_name}' not found or could not be deleted")


async def main():
    """Main entry point"""
    server = GoogleCloudMCPServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
