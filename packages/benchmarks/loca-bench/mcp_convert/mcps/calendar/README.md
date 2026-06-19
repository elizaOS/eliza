# Calendar MCP - Simplified Local Version

A simplified Model Context Protocol (MCP) server that provides Google Calendar-like functionality using local JSON files instead of connecting to the Google Calendar API.

## Overview

This MCP server converts the Google Calendar API into a local, file-based implementation that:
- Works completely offline with no API keys required
- Has no rate limits or usage restrictions
- Provides consistent, predictable data for testing and development
- Implements the same tool interface as the Google Calendar MCP

## Features

### Available Tools

1. **create_event** - Create a new calendar event
2. **get_event** - Retrieve details of a specific event
3. **update_event** - Update an existing event
4. **delete_event** - Delete an event from the calendar
5. **list_events** - List events within a specified time range

### Data Storage

All event data is stored locally in JSON format:
- `data/events.json` - Contains all calendar events with full details

## Installation

### Prerequisites

- Python 3.8+
- `uv` package manager (recommended) or `pip`

### Setup

```bash
# Install dependencies (from project root)
uv sync

# Or with pip
pip install -r requirements.txt
```

### Database Initialization

The Calendar MCP automatically initializes an **empty** database on first run. You can also manually initialize the database:

```bash
# Initialize empty database (default)
cd mcps/calendar
uv run python init_database.py --data-dir /path/to/data

# Initialize with sample events
uv run python init_database.py --data-dir /path/to/data --with-samples

# Force re-initialization
uv run python init_database.py --data-dir /path/to/data --force
```

**Default Behavior**: When starting from scratch (no database exists), the system automatically creates an empty `events.json` file ready for use.

### Configuration

Add to your `.mcp.json` configuration file:

#### Basic Configuration (Default Data Directory)

```json
{
  "mcpServers": {
    "calendar-simplified": {
      "command": "/path/to/uv",
      "args": [
        "--directory",
        "/absolute/path/to/mcp-convert",
        "run",
        "python",
        "mcps/calendar/server.py"
      ]
    }
  }
}
```

#### Custom Data Directory (Per-Task Isolation)

For different tasks or isolated testing, specify a custom data directory using the `CALENDAR_DATA_DIR` environment variable:

```json
{
  "mcpServers": {
    "calendar-task1": {
      "command": "/path/to/uv",
      "args": [
        "--directory",
        "/absolute/path/to/mcp-convert",
        "run",
        "python",
        "mcps/calendar/server.py"
      ],
      "env": {
        "CALENDAR_DATA_DIR": "/path/to/task1/calendar_data"
      }
    },
    "calendar-task2": {
      "command": "/path/to/uv",
      "args": [
        "--directory",
        "/absolute/path/to/mcp-convert",
        "run",
        "python",
        "mcps/calendar/server.py"
      ],
      "env": {
        "CALENDAR_DATA_DIR": "/path/to/task2/calendar_data"
      }
    }
  }
}
```

**Note**: Replace `/path/to/uv` and `/absolute/path/to/mcp-convert` with your actual paths.

### Data Directory Behavior

1. **Default**: Uses `mcps/calendar/data/` if no `CALENDAR_DATA_DIR` is specified
2. **Custom Path**: Set `CALENDAR_DATA_DIR` environment variable to use a different location
3. **Auto-Create**: Directory is automatically created if it doesn't exist
4. **Auto-Initialize**: Empty `events.json` is created if database doesn't exist
5. **Per-Task**: Each task can have its own isolated calendar database

## Usage Examples

### Creating an Event

```json
{
  "tool": "create_event",
  "arguments": {
    "summary": "Team Meeting",
    "start": {
      "dateTime": "2025-11-01T10:00:00-07:00",
      "timeZone": "America/Los_Angeles"
    },
    "end": {
      "dateTime": "2025-11-01T11:00:00-07:00",
      "timeZone": "America/Los_Angeles"
    },
    "description": "Weekly team sync",
    "location": "Conference Room A"
  }
}
```

### Getting Event Details

```json
{
  "tool": "get_event",
  "arguments": {
    "eventId": "event_001"
  }
}
```

### Listing Events in a Time Range

```json
{
  "tool": "list_events",
  "arguments": {
    "timeMin": "2025-10-29T00:00:00-07:00",
    "timeMax": "2025-11-30T23:59:59-07:00",
    "maxResults": 10,
    "orderBy": "startTime"
  }
}
```

### Updating an Event

```json
{
  "tool": "update_event",
  "arguments": {
    "eventId": "event_001",
    "summary": "Updated Meeting Title",
    "location": "New Location",
    "description": "Updated description"
  }
}
```

### Deleting an Event

```json
{
  "tool": "delete_event",
  "arguments": {
    "eventId": "event_001"
  }
}
```

## Data Format

### Event Structure

Each event in `events.json` follows this structure:

```json
{
  "id": "event_001",
  "summary": "Event Title",
  "description": "Event description",
  "location": "Event location",
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
  "creator": {
    "email": "user@example.com",
    "displayName": "User Name"
  },
  "organizer": {
    "email": "user@example.com",
    "displayName": "User Name"
  },
  "status": "confirmed",
  "attendees": [
    {
      "email": "attendee@example.com",
      "displayName": "Attendee Name",
      "responseStatus": "accepted"
    }
  ]
}
```

### All-Day Events

For all-day events, use the `date` field instead of `dateTime`:

```json
{
  "start": {
    "date": "2025-11-15"
  },
  "end": {
    "date": "2025-11-16"
  }
}
```

## Testing

Run the test suite to verify functionality:

```bash
# Run all calendar tests
uv run pytest mcps/calendar/test_server.py -v

# Run specific test class
uv run pytest mcps/calendar/test_server.py::TestCalendarDatabase -v

# Run specific test
uv run pytest mcps/calendar/test_server.py::TestCalendarMCPServer::test_create_event_tool -v
```

## Sample Data

The server comes with 10 pre-populated sample events including:
- Team meetings
- Project planning sessions
- 1:1 meetings
- Client presentations
- Personal appointments
- All-day events
- Workshops and training sessions

## Comparison with Google Calendar MCP

| Feature | Google Calendar MCP | Simplified Calendar MCP |
|---------|---------------------|-------------------------|
| Authentication | OAuth 2.0 required | None required |
| Network | Internet required | Fully offline |
| Rate Limits | Yes (Google API limits) | None |
| Data Persistence | Google's servers | Local JSON files |
| API Costs | May apply quota limits | Free |
| Setup Complexity | OAuth setup needed | Simple file configuration |
| Data Consistency | Real-time updates | Stable test data |
| Use Case | Production calendar access | Development & testing |

## Architecture

### Components

1. **server.py** - Main MCP server implementing the 5 calendar tools
2. **database_utils.py** - Database operations for event management
3. **data/events.json** - Local event storage
4. **test_server.py** - Comprehensive test suite

### Design Patterns

- Extends `BaseMCPServer` from common framework
- Uses `JsonDatabase` for event storage
- Implements caching for efficient event lookups
- Follows MCP protocol for tool definitions and responses

## Customization

### Adding Events

To add sample events, edit `data/events.json`:

```json
[
  {
    "id": "event_011",
    "summary": "New Event",
    "start": {
      "dateTime": "2025-11-20T14:00:00-07:00",
      "timeZone": "America/Los_Angeles"
    },
    "end": {
      "dateTime": "2025-11-20T15:00:00-07:00",
      "timeZone": "America/Los_Angeles"
    },
    "created": "2025-10-29T10:00:00Z",
    "updated": "2025-10-29T10:00:00Z",
    "status": "confirmed",
    "attendees": []
  }
]
```

### Modifying Behavior

Customize the database logic in `database_utils.py`:
- Event filtering logic
- Date/time parsing
- Event sorting algorithms
- Validation rules

## Limitations

This simplified version:
- Does not support recurring events
- Does not implement reminders/notifications
- Does not support calendar sharing or permissions
- Does not handle timezone conversions beyond storage
- Does not support attachments or conferencing data
- Event IDs are auto-generated sequentially (event_001, event_002, etc.)

## Future Enhancements

Potential improvements:
- Add recurring event support
- Implement reminder functionality
- Add calendar categories/colors
- Support for multiple calendars
- Event search by keyword
- Export to iCal format
- Import from external calendar files

## Contributing

When contributing to this MCP:

1. Follow the existing code structure
2. Add tests for new functionality
3. Update documentation
4. Ensure all tests pass before submitting

## License

Part of the MCP Convert framework. See main project LICENSE for details.

## Support

For issues, questions, or contributions, please refer to the main MCP Convert project repository.
