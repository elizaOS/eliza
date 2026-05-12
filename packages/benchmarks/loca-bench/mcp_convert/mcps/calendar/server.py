#!/usr/bin/env python3
"""
Simplified Calendar MCP Server

A Model Context Protocol server that provides Google Calendar-like functionality
using local JSON files as the database instead of connecting to external APIs.

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
from mcps.calendar.database_utils import CalendarDatabase


class CalendarMCPServer(BaseMCPServer):
    """Calendar MCP server implementation"""

    def __init__(self):
        super().__init__("calendar", "1.0.0")

        # Get data directory from environment variable or use default
        data_dir = os.environ.get('CALENDAR_DATA_DIR')
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if data_dir:
            if not quiet:
                print(f"Using Calendar data directory from environment: {data_dir}", file=sys.stderr)
            os.makedirs(data_dir, exist_ok=True)
        else:
            # Use default data directory if not specified
            data_dir = os.path.join(os.path.dirname(__file__), "data")
            if not quiet:
                print(f"Using default Calendar data directory: {data_dir}", file=sys.stderr)

        self.db = CalendarDatabase(data_dir=data_dir)
        self.tool_registry = ToolRegistry()
        self.setup_tools()

    def setup_tools(self):
        """Setup all Calendar tools"""

        # Tool 1: Create event
        self.tool_registry.register(
            name="create_event",
            description="Creates a new event in Google Calendar",
            input_schema={
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Event title"
                    },
                    "start": {
                        "type": "object",
                        "description": "Start time",
                        "properties": {
                            "dateTime": {
                                "type": "string",
                                "description": "Start time (ISO format)"
                            },
                            "timeZone": {
                                "type": "string",
                                "description": "Time zone"
                            }
                        },
                        "required": ["dateTime"]
                    },
                    "end": {
                        "type": "object",
                        "description": "End time",
                        "properties": {
                            "dateTime": {
                                "type": "string",
                                "description": "End time (ISO format)"
                            },
                            "timeZone": {
                                "type": "string",
                                "description": "Time zone"
                            }
                        },
                        "required": ["dateTime"]
                    },
                    "description": {
                        "type": "string",
                        "description": "Event description"
                    },
                    "location": {
                        "type": "string",
                        "description": "Event location"
                    }
                },
                "required": ["summary", "start", "end"]
            },
            handler=self.create_event
        )

        # Tool 2: Get event
        self.tool_registry.register(
            name="get_event",
            description="Retrieves details of a specific event",
            input_schema={
                "type": "object",
                "properties": {
                    "eventId": {
                        "type": "string",
                        "description": "ID of the event to retrieve"
                    }
                },
                "required": ["eventId"]
            },
            handler=self.get_event
        )

        # Tool 3: Update event
        self.tool_registry.register(
            name="update_event",
            description="Updates an existing event",
            input_schema={
                "type": "object",
                "properties": {
                    "eventId": {
                        "type": "string",
                        "description": "ID of the event to update"
                    },
                    "summary": {
                        "type": "string",
                        "description": "New event title"
                    },
                    "start": {
                        "type": "object",
                        "description": "New start time",
                        "properties": {
                            "dateTime": {
                                "type": "string",
                                "description": "New start time (ISO format)"
                            },
                            "timeZone": {
                                "type": "string",
                                "description": "Time zone"
                            }
                        },
                        "required": ["dateTime"]
                    },
                    "end": {
                        "type": "object",
                        "description": "New end time",
                        "properties": {
                            "dateTime": {
                                "type": "string",
                                "description": "New end time (ISO format)"
                            },
                            "timeZone": {
                                "type": "string",
                                "description": "Time zone"
                            }
                        },
                        "required": ["dateTime"]
                    },
                    "description": {
                        "type": "string",
                        "description": "New event description"
                    },
                    "location": {
                        "type": "string",
                        "description": "New event location"
                    }
                },
                "required": ["eventId"]
            },
            handler=self.update_event
        )

        # Tool 4: Delete event
        self.tool_registry.register(
            name="delete_event",
            description="Deletes an event from the calendar",
            input_schema={
                "type": "object",
                "properties": {
                    "eventId": {
                        "type": "string",
                        "description": "ID of the event to delete"
                    }
                },
                "required": ["eventId"]
            },
            handler=self.delete_event
        )

        # Tool 5: List events
        self.tool_registry.register(
            name="list_events",
            description="Lists events within a specified time range",
            input_schema={
                "type": "object",
                "properties": {
                    "timeMin": {
                        "type": "string",
                        "description": "Start of time range (ISO format)"
                    },
                    "timeMax": {
                        "type": "string",
                        "description": "End of time range (ISO format)"
                    },
                    "maxResults": {
                        "type": "number",
                        "description": "Maximum number of events to return"
                    },
                    "orderBy": {
                        "type": "string",
                        "description": "Sort order",
                        "enum": ["startTime", "updated"]
                    }
                },
                "required": ["timeMin", "timeMax"]
            },
            handler=self.list_events
        )

    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()

    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        return await self.tool_registry.call_tool(name, arguments)

    # Tool handlers
    async def create_event(self, args: dict):
        """Create a new event"""
        try:
            event_data = {
                "summary": args["summary"],
                "start": args["start"],
                "end": args["end"]
            }

            # Add optional fields
            if "description" in args:
                event_data["description"] = args["description"]
            if "location" in args:
                event_data["location"] = args["location"]

            new_event = self.db.create_event(event_data)
            return self.create_json_response(new_event)
        except Exception as e:
            return self.create_text_response(f"Error creating event: {str(e)}")

    async def get_event(self, args: dict):
        """Get event details"""
        event_id = args["eventId"]

        event = self.db.get_event(event_id)
        if not event:
            return self.create_text_response(f"Event not found: {event_id}")

        return self.create_json_response(event)

    async def update_event(self, args: dict):
        """Update an existing event"""
        event_id = args["eventId"]

        # Prepare updates (only fields that were provided)
        updates = {}
        for field in ["summary", "start", "end", "description", "location"]:
            if field in args:
                updates[field] = args[field]

        updated_event = self.db.update_event(event_id, updates)
        if not updated_event:
            return self.create_text_response(f"Event not found: {event_id}")

        return self.create_json_response(updated_event)

    async def delete_event(self, args: dict):
        """Delete an event"""
        event_id = args["eventId"]

        success = self.db.delete_event(event_id)
        if not success:
            return self.create_text_response(f"Event not found: {event_id}")

        return self.create_text_response(f"Event {event_id} deleted successfully")

    async def list_events(self, args: dict):
        """List events within time range"""
        time_min = args["timeMin"]
        time_max = args["timeMax"]
        max_results = args.get("maxResults")
        order_by = args.get("orderBy", "startTime")

        events = self.db.list_events(
            time_min=time_min,
            time_max=time_max,
            max_results=max_results,
            order_by=order_by
        )

        # Always return JSON format, even with no events (consistent with Google Calendar API)
        return self.create_json_response({"items": events, "count": len(events)})


async def main():
    """Main entry point"""
    server = CalendarMCPServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
