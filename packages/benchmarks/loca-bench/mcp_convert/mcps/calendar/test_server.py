#!/usr/bin/env python3
"""
Test file for the Calendar MCP Server

Tests all tools and database functionality using the common testing framework.
"""

import pytest
import asyncio
import json
import os
import sys
from typing import Dict, Any
from datetime import datetime, timedelta

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.testing import BaseMCPTest, BaseDataTest, MCPServerTester
from mcps.calendar.server import CalendarMCPServer
from mcps.calendar.database_utils import CalendarDatabase
import mcp.types as types


class TestCalendarDatabase(BaseDataTest):
    """Test the Calendar database utilities"""

    @pytest.fixture
    def database_instance(self):
        """Return Calendar database instance"""
        return CalendarDatabase()

    def test_get_event_valid_id(self, database_instance):
        """Test getting event for a valid ID"""
        result = database_instance.get_event("event_001")
        assert result is not None
        assert result["id"] == "event_001"
        assert result["summary"] == "Team Standup Meeting"
        assert "start" in result
        assert "end" in result

    def test_get_event_invalid_id(self, database_instance):
        """Test getting event for an invalid ID"""
        result = database_instance.get_event("event_999")
        assert result is None

    def test_list_events_with_time_range(self, database_instance):
        """Test listing events within a time range"""
        result = database_instance.list_events(
            time_min="2025-10-29T00:00:00-07:00",
            time_max="2025-10-30T00:00:00-07:00"
        )
        assert isinstance(result, list)
        assert len(result) > 0
        # Verify events are within range
        for event in result:
            start = event.get("start", {})
            assert "dateTime" in start or "date" in start

    def test_list_events_with_max_results(self, database_instance):
        """Test listing events with max results limit"""
        result = database_instance.list_events(
            time_min="2025-10-01T00:00:00-07:00",
            time_max="2025-12-31T23:59:59-07:00",
            max_results=3
        )
        assert isinstance(result, list)
        assert len(result) <= 3

    def test_list_events_ordered_by_start_time(self, database_instance):
        """Test that events are ordered by start time"""
        result = database_instance.list_events(
            time_min="2025-10-01T00:00:00-07:00",
            time_max="2025-12-31T23:59:59-07:00",
            order_by="startTime"
        )
        assert isinstance(result, list)
        # Verify events are sorted
        if len(result) > 1:
            for i in range(len(result) - 1):
                start1 = result[i].get("start", {})
                start2 = result[i + 1].get("start", {})
                time1 = start1.get("dateTime") or start1.get("date")
                time2 = start2.get("dateTime") or start2.get("date")
                assert time1 <= time2

    def test_create_event(self, database_instance):
        """Test creating a new event"""
        event_data = {
            "summary": "Test Event",
            "start": {
                "dateTime": "2025-11-20T10:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "end": {
                "dateTime": "2025-11-20T11:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "description": "This is a test event",
            "location": "Test Location"
        }

        result = database_instance.create_event(event_data)
        assert result is not None
        assert "id" in result
        assert result["summary"] == "Test Event"
        assert result["description"] == "This is a test event"
        assert result["location"] == "Test Location"
        assert "created" in result
        assert "updated" in result

        # Verify event was added to database
        retrieved = database_instance.get_event(result["id"])
        assert retrieved is not None
        assert retrieved["summary"] == "Test Event"

    def test_update_event(self, database_instance):
        """Test updating an existing event"""
        # First create an event
        event_data = {
            "summary": "Original Event",
            "start": {
                "dateTime": "2025-11-25T14:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "end": {
                "dateTime": "2025-11-25T15:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            }
        }
        created = database_instance.create_event(event_data)
        event_id = created["id"]

        # Update the event
        updates = {
            "summary": "Updated Event",
            "description": "New description"
        }
        result = database_instance.update_event(event_id, updates)
        assert result is not None
        assert result["summary"] == "Updated Event"
        assert result["description"] == "New description"

        # Verify update was persisted
        retrieved = database_instance.get_event(event_id)
        assert retrieved["summary"] == "Updated Event"

    def test_update_nonexistent_event(self, database_instance):
        """Test updating a non-existent event"""
        result = database_instance.update_event("event_999", {"summary": "New Title"})
        assert result is None

    def test_delete_event(self, database_instance):
        """Test deleting an event"""
        # First create an event
        event_data = {
            "summary": "Event to Delete",
            "start": {
                "dateTime": "2025-12-01T10:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "end": {
                "dateTime": "2025-12-01T11:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            }
        }
        created = database_instance.create_event(event_data)
        event_id = created["id"]

        # Delete the event
        success = database_instance.delete_event(event_id)
        assert success is True

        # Verify event was deleted
        retrieved = database_instance.get_event(event_id)
        assert retrieved is None

    def test_delete_nonexistent_event(self, database_instance):
        """Test deleting a non-existent event"""
        success = database_instance.delete_event("event_999")
        assert success is False

    def test_database_stats(self, database_instance):
        """Test database statistics"""
        stats = database_instance.get_database_stats()
        assert "total_events" in stats
        assert "files" in stats
        assert stats["total_events"] >= 0


class TestCalendarMCPServer(BaseMCPTest):
    """Test the Calendar MCP server"""

    @pytest.fixture
    def server_instance(self):
        """Return Calendar MCP server instance"""
        return CalendarMCPServer()

    @pytest.fixture
    def mcp_tester(self, server_instance):
        """Return MCP server tester"""
        return MCPServerTester(server_instance)

    @pytest.mark.asyncio
    async def test_all_tools_exist(self, mcp_tester):
        """Test that all expected tools exist"""
        expected_tools = [
            "create_event",
            "get_event",
            "update_event",
            "delete_event",
            "list_events"
        ]

        results = await mcp_tester.test_all_tools_exist(expected_tools)
        for tool_name, exists in results.items():
            assert exists, f"Tool {tool_name} should exist"

    @pytest.mark.asyncio
    async def test_create_event_tool(self, mcp_tester):
        """Test the create_event MCP tool"""
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "create_event",
            {
                "summary": "MCP Test Event",
                "start": {
                    "dateTime": "2025-11-30T10:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                },
                "end": {
                    "dateTime": "2025-11-30T11:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                },
                "description": "Test event created via MCP",
                "location": "MCP Test Location"
            }
        )
        assert is_valid

    @pytest.mark.asyncio
    async def test_get_event_tool(self, mcp_tester):
        """Test the get_event MCP tool"""
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "get_event",
            {"eventId": "event_001"}
        )
        assert is_valid

    @pytest.mark.asyncio
    async def test_get_event_tool_invalid_id(self, mcp_tester):
        """Test get_event with invalid ID"""
        result = await mcp_tester.call_tool_safe(
            "get_event",
            {"eventId": "event_999"}
        )
        # Should return a response (not error), but indicate event not found
        assert result is not None

    @pytest.mark.asyncio
    async def test_list_events_tool(self, mcp_tester):
        """Test the list_events MCP tool"""
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "list_events",
            {
                "timeMin": "2025-10-29T00:00:00-07:00",
                "timeMax": "2025-11-30T23:59:59-07:00"
            }
        )
        assert is_valid

    @pytest.mark.asyncio
    async def test_list_events_tool_with_options(self, mcp_tester):
        """Test list_events with max results and order by"""
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "list_events",
            {
                "timeMin": "2025-10-01T00:00:00-07:00",
                "timeMax": "2025-12-31T23:59:59-07:00",
                "maxResults": 5,
                "orderBy": "startTime"
            }
        )
        assert is_valid

    @pytest.mark.asyncio
    async def test_update_event_tool(self, mcp_tester):
        """Test the update_event MCP tool"""
        # First create an event to update
        create_result = await mcp_tester.call_tool_safe(
            "create_event",
            {
                "summary": "Event to Update",
                "start": {
                    "dateTime": "2025-12-05T15:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                },
                "end": {
                    "dateTime": "2025-12-05T16:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                }
            }
        )

        # Extract event ID from response
        response_text = create_result[0].text
        event_data = json.loads(response_text)
        event_id = event_data["id"]

        # Now update it
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "update_event",
            {
                "eventId": event_id,
                "summary": "Updated Event Title",
                "description": "Updated description"
            }
        )
        assert is_valid

    @pytest.mark.asyncio
    async def test_delete_event_tool(self, mcp_tester):
        """Test the delete_event MCP tool"""
        # First create an event to delete
        create_result = await mcp_tester.call_tool_safe(
            "create_event",
            {
                "summary": "Event to Delete",
                "start": {
                    "dateTime": "2025-12-10T09:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                },
                "end": {
                    "dateTime": "2025-12-10T10:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                }
            }
        )

        # Extract event ID from response
        response_text = create_result[0].text
        event_data = json.loads(response_text)
        event_id = event_data["id"]

        # Now delete it
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "delete_event",
            {"eventId": event_id}
        )
        assert is_valid

    @pytest.mark.asyncio
    async def test_delete_event_tool_invalid_id(self, mcp_tester):
        """Test delete_event with invalid ID"""
        result = await mcp_tester.call_tool_safe(
            "delete_event",
            {"eventId": "event_999"}
        )
        # Should return a response (not error), but indicate event not found
        assert result is not None

    @pytest.mark.asyncio
    async def test_full_event_lifecycle(self, mcp_tester):
        """Test complete event lifecycle: create, get, update, delete"""
        # Create
        create_result = await mcp_tester.call_tool_safe(
            "create_event",
            {
                "summary": "Lifecycle Test Event",
                "start": {
                    "dateTime": "2025-12-15T14:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                },
                "end": {
                    "dateTime": "2025-12-15T15:00:00-07:00",
                    "timeZone": "America/Los_Angeles"
                },
                "description": "Testing full lifecycle"
            }
        )
        event_data = json.loads(create_result[0].text)
        event_id = event_data["id"]
        assert event_data["summary"] == "Lifecycle Test Event"

        # Get
        get_result = await mcp_tester.call_tool_safe("get_event", {"eventId": event_id})
        get_data = json.loads(get_result[0].text)
        assert get_data["id"] == event_id
        assert get_data["summary"] == "Lifecycle Test Event"

        # Update
        update_result = await mcp_tester.call_tool_safe(
            "update_event",
            {
                "eventId": event_id,
                "summary": "Updated Lifecycle Event",
                "location": "New Location"
            }
        )
        update_data = json.loads(update_result[0].text)
        assert update_data["summary"] == "Updated Lifecycle Event"
        assert update_data["location"] == "New Location"

        # Delete
        delete_result = await mcp_tester.call_tool_safe("delete_event", {"eventId": event_id})
        assert delete_result is not None

        # Verify deletion
        get_after_delete = await mcp_tester.call_tool_safe("get_event", {"eventId": event_id})
        response_text = get_after_delete[0].text
        assert "not found" in response_text.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
