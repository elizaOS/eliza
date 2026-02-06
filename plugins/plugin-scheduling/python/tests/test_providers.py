"""Tests for providers."""

from __future__ import annotations

import uuid

import pytest

from elizaos_plugin_scheduling.providers.scheduling_context import (
    _format_meeting_for_context,
    scheduling_context_provider,
)
from elizaos_plugin_scheduling.service import SchedulingService
from elizaos_plugin_scheduling.types import (
    LocationType,
    Meeting,
    MeetingLocation,
    MeetingParticipant,
    MeetingStatus,
    ParticipantRole,
    TimeSlot,
)


class TestSchedulingContextProvider:
    def test_metadata(self) -> None:
        assert scheduling_context_provider["name"] == "SCHEDULING_CONTEXT"
        assert "description" in scheduling_context_provider
        assert callable(scheduling_context_provider["get"])

    def test_format_meeting_virtual(self) -> None:
        meeting = Meeting(
            id="m1",
            request_id="r1",
            room_id="room1",
            title="Standup",
            slot=TimeSlot(
                start="2025-01-20T15:00:00Z",
                end="2025-01-20T15:30:00Z",
                time_zone="America/New_York",
            ),
            location=MeetingLocation(type=LocationType.VIRTUAL),
            participants=[
                MeetingParticipant(
                    entity_id="e1", name="Alice", role=ParticipantRole.ORGANIZER
                ),
            ],
            status=MeetingStatus.PROPOSED,
        )

        from .conftest import MockAgentRuntime

        runtime = MockAgentRuntime()
        service = SchedulingService(runtime)

        result = _format_meeting_for_context(meeting, service)
        assert '"Standup"' in result
        assert "virtual meeting" in result
        assert "Alice" in result
        assert "proposed" in result

    def test_format_meeting_in_person(self) -> None:
        meeting = Meeting(
            id="m2",
            request_id="r2",
            room_id="room2",
            title="Lunch",
            slot=TimeSlot(
                start="2025-01-20T17:00:00Z",
                end="2025-01-20T18:00:00Z",
                time_zone="UTC",
            ),
            location=MeetingLocation(type=LocationType.IN_PERSON, name="Cafe Noir"),
            participants=[
                MeetingParticipant(
                    entity_id="e1", name="Bob", role=ParticipantRole.REQUIRED
                ),
            ],
            status=MeetingStatus.CONFIRMED,
        )

        from .conftest import MockAgentRuntime

        runtime = MockAgentRuntime()
        service = SchedulingService(runtime)

        result = _format_meeting_for_context(meeting, service)
        assert "at Cafe Noir" in result
        assert "confirmed" in result
