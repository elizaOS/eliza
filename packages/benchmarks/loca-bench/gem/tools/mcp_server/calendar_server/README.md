# Calendar MCP Tool

A Model Context Protocol (MCP) tool for interacting with Google Calendar. This tool provides a local implementation using JSON files as the database, making it perfect for development and testing without requiring actual Google Calendar API credentials.

## Features

### Key Capabilities

- **Event Management**:
  - Create new calendar events
  - Retrieve event details
  - Update existing events
  - Delete events
  - List events within a time range

- **Event Properties**:
  - Event title (summary)
  - Start and end times with timezone support
  - Event description
  - Event location
  - ISO 8601 datetime format support

## Installation

The Calendar MCP Tool is part of the `gem` package. Make sure you have the required dependencies:

```bash
pip install gem
# or if using uv
uv pip install gem
```

## Usage

### Method 1: stdio Mode (Recommended)

The stdio mode auto-starts the server - no manual setup required!

```python
from gem.tools.mcp_server.calendar import create_calendar_tool_stdio

# Create the tool
tool = create_calendar_tool_stdio(
    data_dir="./calendar_data",  # Local database directory
    validate_on_init=False
)

# List available tools
tools = tool.get_available_tools()
print(f"Available tools: {len(tools)}")

# List events
action = '''<tool_call>
<tool_name>list_events</tool_name>
<parameters>
<timeMin>2024-01-01T00:00:00Z</timeMin>
<timeMax>2024-12-31T23:59:59Z</timeMax>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)

# Create an event
action = '''<tool_call>
<tool_name>create_event</tool_name>
<parameters>
<summary>Team Meeting</summary>
<start>
  <dateTime>2024-01-15T10:00:00</dateTime>
  <timeZone>America/New_York</timeZone>
</start>
<end>
  <dateTime>2024-01-15T11:00:00</dateTime>
  <timeZone>America/New_York</timeZone>
</end>
<description>Quarterly planning meeting</description>
<location>Conference Room A</location>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
```

### Method 2: HTTP Mode

For HTTP mode, you need to start the server manually first:

```bash
# Start the server
cd /path/to/mcp_convert
uv run python mcps/calendar/server.py --transport streamable-http --port 8082
```

Then in Python:

```python
from gem.tools.mcp_server.calendar import create_calendar_tool_http

# Connect to running server
tool = create_calendar_tool_http(
    calendar_url="http://127.0.0.1:8082/calendar-mcp",
    validate_on_init=False
)

# Use the tool
tools = tool.get_available_tools()
```

### Multi-Server Configuration

Combine Calendar with other MCP servers:

```python
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.calendar import get_calendar_stdio_config
from gem.tools.mcp_server.emails import get_email_stdio_config

# Get individual server configs
calendar_config = get_calendar_stdio_config(data_dir="./calendar_data")
email_config = get_email_stdio_config(data_dir="./email_data")

# Merge configs
merged_config = {
    "mcpServers": {
        **calendar_config,
        **email_config
    }
}

# Create combined tool
tool = MCPTool(merged_config, validate_on_init=False)

# Now you can use both Calendar and Email tools!
```

## Configuration

### Environment Variables

- `CALENDAR_DATA_DIR`: Path to the local database directory
  - If not set, defaults to `./calendar_data`
  - The directory will be created automatically if it doesn't exist

### YAML Configuration

Example configuration for MCP client:

```yaml
type: stdio
name: calendar
params:
  command: uv
  args:
    - "--directory"
    - "/path/to/mcp_convert"
    - "run"
    - "python"
    - "mcps/calendar/server.py"
  env:
    CALENDAR_DATA_DIR: "${workspace_parent}/local_db/calendar"
client_session_timeout_seconds: 30
cache_tools_list: true
```

## Examples

### Example 1: Create and List Events

```python
tool = create_calendar_tool_stdio()

# Create an event
action = '''<tool_call>
<tool_name>create_event</tool_name>
<parameters>
<summary>Project Review</summary>
<start>
  <dateTime>2024-02-01T14:00:00</dateTime>
  <timeZone>UTC</timeZone>
</start>
<end>
  <dateTime>2024-02-01T15:30:00</dateTime>
  <timeZone>UTC</timeZone>
</end>
<description>Review project progress and next steps</description>
<location>Virtual Meeting</location>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
print(obs)  # Returns the created event with ID

# List all events in February
action = '''<tool_call>
<tool_name>list_events</tool_name>
<parameters>
<timeMin>2024-02-01T00:00:00Z</timeMin>
<timeMax>2024-02-29T23:59:59Z</timeMax>
<maxResults>100</maxResults>
<orderBy>startTime</orderBy>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
print(obs)
```

### Example 2: Get and Update Event

```python
tool = create_calendar_tool_stdio()

# Get event details
action = '''<tool_call>
<tool_name>get_event</tool_name>
<parameters>
<eventId>event_123456</eventId>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)

# Update event
action = '''<tool_call>
<tool_name>update_event</tool_name>
<parameters>
<eventId>event_123456</eventId>
<summary>Updated: Project Review</summary>
<start>
  <dateTime>2024-02-01T15:00:00</dateTime>
  <timeZone>UTC</timeZone>
</start>
<end>
  <dateTime>2024-02-01T16:30:00</dateTime>
  <timeZone>UTC</timeZone>
</end>
<location>Conference Room B</location>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
```

### Example 3: Delete Event

```python
tool = create_calendar_tool_stdio()

# Delete an event
action = '''<tool_call>
<tool_name>delete_event</tool_name>
<parameters>
<eventId>event_123456</eventId>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
```

### Example 4: Working with Time Zones

```python
tool = create_calendar_tool_stdio()

# Create event with specific timezone
action = '''<tool_call>
<tool_name>create_event</tool_name>
<parameters>
<summary>International Meeting</summary>
<start>
  <dateTime>2024-03-15T09:00:00</dateTime>
  <timeZone>America/Los_Angeles</timeZone>
</start>
<end>
  <dateTime>2024-03-15T10:00:00</dateTime>
  <timeZone>America/Los_Angeles</timeZone>
</end>
<description>Meeting with international team</description>
</parameters>
</tool_call>'''
is_valid, has_error, obs, parsed = tool.execute_action(action)
```

## Data Storage

All data is stored locally in JSON files within the specified `data_dir`:

```
calendar_data/
└── events.json    # All calendar events
```

## Available Tools

1. **create_event** - Create a new calendar event
   - Required: summary, start, end
   - Optional: description, location

2. **get_event** - Get details of a specific event
   - Required: eventId

3. **update_event** - Update an existing event
   - Required: eventId
   - Optional: summary, start, end, description, location

4. **delete_event** - Delete an event
   - Required: eventId

5. **list_events** - List events in a time range
   - Required: timeMin, timeMax
   - Optional: maxResults, orderBy

## Benefits

1. **No Google API Credentials Required**: Works entirely offline with local JSON storage
2. **Fast Development**: No network latency or API quotas
3. **Reproducible**: Same data across different environments
4. **Cost-Free**: No API usage charges
5. **Easy Testing**: Perfect for unit tests and integration tests

## Architecture

The Calendar MCP Tool follows the same pattern as other MCP tools:

```
gem/tools/mcp_server/calendar/
├── __init__.py          # Public API exports
├── helper.py            # Tool creation functions
└── README.md            # This file

mcp_convert/mcps/calendar/
├── server.py            # MCP server implementation
├── database_utils.py    # Local JSON database
└── data/                # Default data directory
```

## Related Tools

- [Email MCP Tool](../emails/README.md) - Email management system
- [Google Cloud MCP Tool](../google_cloud/README.md) - Google Cloud Platform integration
- [Canvas MCP Tool](../canvas/README.md) - Learning management system

## License

See the main gem project license.











