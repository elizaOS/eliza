# Calendar MCP Initialization Guide

This document explains how the Calendar MCP handles database initialization and custom data directories.

## Overview

The Calendar MCP follows the same pattern as Canvas and Email MCPs for database initialization and configuration. It supports:

1. **Automatic initialization** - Empty database created on first run
2. **Custom data directories** - Per-task data isolation via environment variables
3. **Manual initialization** - Command-line tool for setup
4. **From-scratch operation** - Works immediately without pre-existing data

## Automatic Initialization

When the Calendar MCP starts and no database exists, it automatically:

1. Creates the data directory (if it doesn't exist)
2. Creates an empty `events.json` file
3. Logs initialization messages to stderr

### Example Output

```
Using Calendar data directory from environment: /path/to/data
Database not found or incomplete. Initializing new database in: /path/to/data
Initializing Calendar database in: /path/to/data
  Created events.json (empty)

Database initialization complete!

Empty calendar ready for use.
```

## Custom Data Directories

### Environment Variable

Set the `CALENDAR_DATA_DIR` environment variable to specify a custom data location:

```bash
export CALENDAR_DATA_DIR=/path/to/custom/data
python mcps/calendar/server.py
```

### MCP Configuration

In `.mcp.json`, use the `env` field to set per-server data directories:

```json
{
  "mcpServers": {
    "calendar-project-a": {
      "command": "uv",
      "args": ["run", "python", "mcps/calendar/server.py"],
      "env": {
        "CALENDAR_DATA_DIR": "/data/projects/project-a/calendar"
      }
    },
    "calendar-project-b": {
      "command": "uv",
      "args": ["run", "python", "mcps/calendar/server.py"],
      "env": {
        "CALENDAR_DATA_DIR": "/data/projects/project-b/calendar"
      }
    }
  }
}
```

### Benefits

- **Task Isolation**: Each task/project has its own calendar data
- **Clean Testing**: Create temporary databases for testing
- **Multi-Environment**: Run multiple independent calendar instances
- **Backup & Restore**: Easy to copy entire data directories

## Manual Initialization

Use the `init_database.py` script for manual control:

### Basic Usage

```bash
# Navigate to calendar MCP directory
cd mcps/calendar

# Initialize empty database
uv run python init_database.py --data-dir /path/to/data

# Initialize with sample events
uv run python init_database.py --data-dir /path/to/data --with-samples

# Force re-initialization (overwrites existing)
uv run python init_database.py --data-dir /path/to/data --force
```

### Options

| Option | Description |
|--------|-------------|
| `--data-dir PATH` | Directory for database files (default: `./data`) |
| `--with-samples` | Include sample events instead of starting empty |
| `--force` | Re-initialize even if database already exists |

### Sample Events

When using `--with-samples`, the following events are created:

1. **Team Standup Meeting** (event_001)
   - Daily standup with engineering team
   - Conference Room A
   - 30-minute meeting

2. **Project Planning Session** (event_002)
   - Q4 project planning and roadmap
   - Zoom Meeting
   - 2-hour meeting

## Database Structure

### File Layout

```
<data_dir>/
└── events.json          # All calendar events (JSON array)
```

### Empty Database

An empty `events.json` contains:

```json
[]
```

### With Events

```json
[
  {
    "id": "event_001",
    "summary": "Event Title",
    "description": "Event description",
    "location": "Location",
    "start": {
      "dateTime": "2025-10-29T09:00:00-07:00",
      "timeZone": "America/Los_Angeles"
    },
    "end": {
      "dateTime": "2025-10-29T10:00:00-07:00",
      "timeZone": "America/Los_Angeles"
    },
    "created": "2025-10-20T10:00:00Z",
    "updated": "2025-10-20T10:00:00Z",
    "status": "confirmed",
    "creator": {...},
    "organizer": {...},
    "attendees": [...]
  }
]
```

## Initialization Logic

### Database Check

The system checks if a database is initialized by verifying:

1. Data directory exists
2. `events.json` file exists
3. `events.json` contains valid JSON
4. JSON content is a list (array)

If any check fails, the database is re-initialized.

### Initialization Process

```python
def _ensure_database_initialized(self):
    """Ensure database is initialized, create if needed"""
    if not check_database_initialized(self.data_dir):
        print(f"Database not found. Initializing in: {self.data_dir}")
        initialize_database(self.data_dir, verbose=True, with_samples=False)
        print("Database initialization complete")
```

## Use Cases

### 1. Development Testing

```bash
# Create temporary test database
export CALENDAR_DATA_DIR=/tmp/calendar_test_$(date +%s)
python mcps/calendar/server.py
```

### 2. CI/CD Pipelines

```yaml
# GitHub Actions example
- name: Run Calendar MCP Tests
  env:
    CALENDAR_DATA_DIR: ${{ runner.temp }}/calendar_data
  run: |
    python mcps/calendar/server.py &
    sleep 2
    pytest tests/
```

### 3. Multi-Project Workspace

```json
{
  "mcpServers": {
    "calendar-client-alpha": {
      "env": {"CALENDAR_DATA_DIR": "./data/clients/alpha/calendar"}
    },
    "calendar-client-beta": {
      "env": {"CALENDAR_DATA_DIR": "./data/clients/beta/calendar"}
    },
    "calendar-internal": {
      "env": {"CALENDAR_DATA_DIR": "./data/internal/calendar"}
    }
  }
}
```

### 4. Backup and Migration

```bash
# Backup
tar -czf calendar_backup_$(date +%Y%m%d).tar.gz /path/to/calendar/data

# Restore
tar -xzf calendar_backup_20251029.tar.gz -C /new/path

# Use restored data
export CALENDAR_DATA_DIR=/new/path/data
python mcps/calendar/server.py
```

## Error Handling

### Missing Directory

If the data directory doesn't exist, it's automatically created:

```python
os.makedirs(data_dir, exist_ok=True)
```

### Corrupted Database

If `events.json` is corrupted (invalid JSON), the database is re-initialized with an empty file.

### Permissions

Ensure the process has read/write permissions to the data directory:

```bash
chmod 755 /path/to/data
chmod 644 /path/to/data/events.json
```

## Best Practices

1. **Use Environment Variables**: Don't hardcode paths; use `CALENDAR_DATA_DIR`
2. **Separate Environments**: Use different directories for dev/test/prod
3. **Regular Backups**: Backup data directories before major changes
4. **Clean Temporary Data**: Remove test databases after use
5. **Version Control**: Don't commit data directories to git (add to `.gitignore`)

## Comparison with Other MCPs

| Feature | Calendar MCP | Canvas MCP | Email MCP |
|---------|--------------|------------|-----------|
| Environment Variable | `CALENDAR_DATA_DIR` | `CANVAS_DATA_DIR` | `EMAIL_DATA_DIR` |
| Auto-Initialize | ✓ Empty events | ✓ With users | ✓ With users |
| Manual Init Script | ✓ `init_database.py` | ✓ `init_database.py` | ✓ `init_database.py` |
| Sample Data Option | ✓ `--with-samples` | ✓ With sample data | ✓ With sample data |
| Default Location | `mcps/calendar/data` | `mcps/canvas/data` | `mcps/email/data` |

## Troubleshooting

### Database Not Initializing

```bash
# Check permissions
ls -la /path/to/data

# Manually initialize
cd mcps/calendar
python init_database.py --data-dir /path/to/data --force
```

### Events Not Persisting

```bash
# Verify data directory
echo $CALENDAR_DATA_DIR

# Check file permissions
ls -la $CALENDAR_DATA_DIR/events.json

# Verify JSON is valid
python -m json.tool $CALENDAR_DATA_DIR/events.json
```

### Multiple Instances Conflict

Ensure each instance uses a different data directory:

```bash
# Instance 1
CALENDAR_DATA_DIR=/data/instance1 python mcps/calendar/server.py &

# Instance 2
CALENDAR_DATA_DIR=/data/instance2 python mcps/calendar/server.py &
```

## Summary

The Calendar MCP initialization system provides:

- ✅ Zero-configuration startup (works from scratch)
- ✅ Flexible data directory configuration
- ✅ Per-task/project isolation
- ✅ Consistent pattern with Canvas and Email MCPs
- ✅ Automatic database creation
- ✅ Manual control when needed
- ✅ Clean testing and development workflows
