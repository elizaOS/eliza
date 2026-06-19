# Google Cloud MCP Server

A simplified Google Cloud Platform MCP server using local file-based database instead of external APIs.

## Overview

This MCP server provides local implementations of Google Cloud Platform services:

### BigQuery
- **bigquery-list-datasets** - List BigQuery datasets
- **bigquery-get-dataset** - Get dataset details
- **bigquery-create-dataset** - Create a new dataset
- **bigquery-delete-dataset** - Delete a dataset
- **bigquery-list-tables** - List tables in a dataset
- **bigquery-get-table** - Get table details
- **bigquery-create-table** - Create a new table
- **bigquery-delete-table** - Delete a table
- **bigquery-query** - Run a SQL query (simulated)
- **bigquery-get-query-result** - Get query results

### Cloud Storage
- **storage-list-buckets** - List all storage buckets
- **storage-get-bucket** - Get bucket details
- **storage-create-bucket** - Create a new bucket
- **storage-delete-bucket** - Delete a bucket
- **storage-list-objects** - List objects in a bucket
- **storage-get-object** - Get object details
- **storage-upload-object** - Upload an object
- **storage-delete-object** - Delete an object

### Compute Engine
- **compute-list-instances** - List VM instances
- **compute-get-instance** - Get instance details
- **compute-create-instance** - Create a new instance
- **compute-delete-instance** - Delete an instance
- **compute-start-instance** - Start an instance
- **compute-stop-instance** - Stop an instance

### IAM (Identity and Access Management)
- **iam-list-service-accounts** - List service accounts
- **iam-get-service-account** - Get service account details
- **iam-create-service-account** - Create a service account
- **iam-delete-service-account** - Delete a service account
- **iam-add-service-account-role** - Add a role to service account
- **iam-remove-service-account-role** - Remove a role from service account

### Utilities
- **get-database-stats** - Get database statistics

## Data Files

Located in `data/` directory:

- `bigquery_datasets.json` - BigQuery datasets
- `bigquery_tables.json` - BigQuery tables
- `query_results.json` - Query execution results
- `storage_buckets.json` - Cloud Storage buckets
- `storage_objects.json` - Cloud Storage objects
- `compute_instances.json` - Compute Engine instances
- `iam_service_accounts.json` - IAM service accounts

## Sample Data

The server includes sample data for:

### BigQuery
- **project-1:analytics_dataset** - Analytics dataset with user events and sessions tables
- **project-1:sales_dataset** - Sales dataset with transactions table
- **project-2:ml_dataset** - ML dataset with training data table

### Cloud Storage
- **my-app-data-prod** - Production data bucket (STANDARD storage)
- **my-app-backups** - Backup bucket (NEARLINE storage)
- **ml-models-staging** - ML models staging bucket

### Compute Engine
- **web-server-prod-1** - Production web server (RUNNING)
- **api-server-prod-1** - Production API server (RUNNING)
- **ml-training-vm** - ML training VM (TERMINATED)

### IAM
- **backend-service@project-1** - Backend service account
- **ml-pipeline@project-2** - ML pipeline service account
- **backup-service@project-1** - Backup service account

## Usage

### Running the Server

```bash
# From project root
uv run python mcps/google_cloud/server.py

# Or with specific Python version
python3 mcps/google_cloud/server.py
```

### Example Tool Calls

#### BigQuery Examples

```python
# List all datasets
{"tool": "bigquery-list-datasets"}

# List datasets for a specific project
{"tool": "bigquery-list-datasets", "projectId": "project-1"}

# Get dataset details
{"tool": "bigquery-get-dataset", "projectId": "project-1", "datasetId": "analytics_dataset"}

# Create a new dataset
{
    "tool": "bigquery-create-dataset",
    "projectId": "my-project",
    "datasetId": "new_dataset",
    "location": "US",
    "description": "My new dataset"
}

# List tables in a dataset
{"tool": "bigquery-list-tables", "projectId": "project-1", "datasetId": "analytics_dataset"}

# Get table details
{
    "tool": "bigquery-get-table",
    "projectId": "project-1",
    "datasetId": "analytics_dataset",
    "tableId": "user_events"
}

# Run a query
{
    "tool": "bigquery-query",
    "query": "SELECT COUNT(*) as total FROM `project-1.analytics_dataset.user_events`"
}
```

#### Cloud Storage Examples

```python
# List all buckets
{"tool": "storage-list-buckets"}

# Get bucket details
{"tool": "storage-get-bucket", "bucketName": "my-app-data-prod"}

# Create a new bucket
{
    "tool": "storage-create-bucket",
    "bucketName": "my-new-bucket",
    "location": "US",
    "storageClass": "STANDARD"
}

# List objects in a bucket
{"tool": "storage-list-objects", "bucketName": "my-app-data-prod"}

# List objects with prefix filter
{"tool": "storage-list-objects", "bucketName": "my-app-data-prod", "prefix": "data/"}

# Upload an object
{
    "tool": "storage-upload-object",
    "bucketName": "my-app-data-prod",
    "objectName": "data/file.txt",
    "contentType": "text/plain",
    "size": 1024
}
```

#### Compute Engine Examples

```python
# List all instances
{"tool": "compute-list-instances"}

# List instances in a specific zone
{"tool": "compute-list-instances", "zone": "us-central1-a"}

# Get instance details
{"tool": "compute-get-instance", "instanceName": "web-server-prod-1"}

# Create a new instance
{
    "tool": "compute-create-instance",
    "instanceName": "new-instance",
    "zone": "us-central1-a",
    "machineType": "n1-standard-4"
}

# Start an instance
{"tool": "compute-start-instance", "instanceName": "ml-training-vm"}

# Stop an instance
{"tool": "compute-stop-instance", "instanceName": "web-server-prod-1"}
```

#### IAM Examples

```python
# List all service accounts
{"tool": "iam-list-service-accounts"}

# List service accounts for a project
{"tool": "iam-list-service-accounts", "projectId": "project-1"}

# Get service account details
{"tool": "iam-get-service-account", "email": "backend-service@project-1.iam.gserviceaccount.com"}

# Create a service account
{
    "tool": "iam-create-service-account",
    "email": "new-service@my-project.iam.gserviceaccount.com",
    "projectId": "my-project",
    "displayName": "New Service Account",
    "description": "Service account for new application"
}

# Add a role to service account
{
    "tool": "iam-add-service-account-role",
    "email": "backend-service@project-1.iam.gserviceaccount.com",
    "role": "roles/bigquery.dataEditor"
}

# Remove a role from service account
{
    "tool": "iam-remove-service-account-role",
    "email": "backend-service@project-1.iam.gserviceaccount.com",
    "role": "roles/bigquery.dataEditor"
}
```

## Testing

Run the comprehensive test suite:

```bash
# Run all tests
uv run pytest mcps/google_cloud/test_server.py -v

# Run specific test class
uv run pytest mcps/google_cloud/test_server.py::TestBigQuery -v

# Run specific test
uv run pytest mcps/google_cloud/test_server.py::TestBigQuery::test_list_datasets -v
```

Test coverage includes:
- ✅ BigQuery datasets and tables management
- ✅ BigQuery query execution
- ✅ Cloud Storage buckets and objects management
- ✅ Compute Engine instances management
- ✅ IAM service accounts and roles management
- ✅ Database operations
- ✅ Server integration

## Configuration

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "google-cloud": {
      "command": "/opt/homebrew/Caskroom/miniforge/base/bin/uv",
      "args": [
        "--directory",
        "/path/to/mcp-convert",
        "run",
        "python",
        "mcps/google_cloud/server.py"
      ]
    }
  }
}
```

Or for direct Python execution:

```json
{
  "mcpServers": {
    "google-cloud": {
      "command": "python3",
      "args": [
        "/path/to/mcp-convert/mcps/google_cloud/server.py"
      ]
    }
  }
}
```

## Adding Data

To add new data to the server:

1. **Edit data files** in the `data/` directory
2. **Follow existing format** in JSON files
3. **Run tests** to validate data integrity
4. **Restart server** to load new data

### Data Format Examples

#### BigQuery Dataset
```json
{
  "project-id:dataset-id": {
    "datasetId": "dataset-id",
    "projectId": "project-id",
    "location": "US",
    "description": "Dataset description",
    "created": "2024-01-01T00:00:00Z",
    "modified": "2024-01-01T00:00:00Z",
    "labels": {
      "env": "production"
    }
  }
}
```

#### Cloud Storage Bucket
```json
{
  "bucket-name": {
    "name": "bucket-name",
    "location": "US",
    "storageClass": "STANDARD",
    "created": "2024-01-01T00:00:00Z",
    "updated": "2024-01-01T00:00:00Z",
    "labels": {
      "env": "production"
    },
    "versioning": {"enabled": true}
  }
}
```

#### Compute Instance
```json
{
  "instance-name": {
    "id": "1234567890",
    "name": "instance-name",
    "zone": "us-central1-a",
    "machineType": "n1-standard-4",
    "status": "RUNNING",
    "networkInterfaces": [...],
    "disks": [...],
    "labels": {},
    "created": "2024-01-01T00:00:00Z"
  }
}
```

## Benefits

- ✅ **Offline functionality** - No internet required
- ✅ **No rate limits** - Unlimited queries
- ✅ **Fast responses** - Local file access
- ✅ **Consistent data** - Perfect for testing
- ✅ **Easy to extend** - Just modify JSON files
- ✅ **No API keys required** - No authentication needed
- ✅ **No costs** - No cloud billing
- ✅ **Full control** - Complete data ownership

## Comparison with Real Google Cloud

| Feature | Real GCP | This Server |
|---------|----------|-------------|
| Authentication | OAuth 2.0, Service Accounts | None required |
| Rate Limits | Yes | None |
| Cost | Pay per use | Free |
| Latency | Network dependent | Instant |
| Data Persistence | Cloud storage | Local JSON files |
| Query Execution | Real BigQuery engine | Simulated |
| Instance Management | Real VMs | Metadata only |

## Extending the Server

To add new tools:

1. **Add tool registration** in `server.py` `setup_tools()` method:
```python
self.tool_registry.register(
    name="new-tool-name",
    description="Tool description",
    input_schema=create_simple_tool_schema(
        required_params=["param1"],
        optional_params={"param2": {"type": "string"}}
    ),
    handler=self.new_tool_handler
)
```

2. **Implement tool handler** method:
```python
async def new_tool_handler(self, args: dict):
    """Handle new tool"""
    param1 = args["param1"]
    result = self.db.some_database_method(param1)
    return self.create_json_response(result)
```

3. **Add database methods** in `database_utils.py` if needed
4. **Add tests** in `test_server.py`
5. **Update documentation** in this README

## Troubleshooting

### Server won't start
- Check Python version (3.12+ required)
- Verify all data files exist in `data/` directory
- Check for JSON syntax errors in data files

### Tests failing
- Run `uv sync` to ensure dependencies are installed
- Check that data files haven't been corrupted
- Verify file permissions

### Tool not found
- Check tool name spelling
- Verify tool is registered in `setup_tools()`
- Run `list_tools()` to see available tools

## Architecture

```
mcps/google_cloud/
├── server.py              # MCP server implementation
├── database_utils.py      # Database operations
├── test_server.py         # Test suite
├── README.md              # This file
└── data/                  # Local database
    ├── bigquery_datasets.json
    ├── bigquery_tables.json
    ├── query_results.json
    ├── storage_buckets.json
    ├── storage_objects.json
    ├── compute_instances.json
    └── iam_service_accounts.json
```

## License

Part of the mcp-convert project. See project root for license information.

## Related Projects

- [Real Google Cloud Python Client](https://github.com/googleapis/google-cloud-python)
- [MCP Protocol Specification](https://modelcontextprotocol.org)
- [Pipedream Google Cloud MCP](https://mcp.pipedream.com/app/google_cloud)

## Contributing

Contributions welcome! Please:
1. Add tests for new features
2. Update documentation
3. Follow existing code style
4. Ensure all tests pass

## Support

For issues or questions:
1. Check this README
2. Review test files for examples
3. Check common/ directory for framework documentation
