"""Tests for the SchedulingService."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from elizaos_plugin_scheduling.config import SchedulingServiceConfig
from elizaos_plugin_scheduling.error import MeetingNotFoundError, ParticipantNotFoundError
from elizaos_plugin_scheduling.service import SchedulingService
from elizaos_plugin_scheduling.types import (
    Availability,
    AvailabilityException,
    AvailabilityWindow,
    DayOfWeek,
    LocationType,
    Meeting,
    MeetingLocation,
    MeetingParticipant,
    MeetingStatus,
    Participant,
    ParticipantRole,
    SchedulingConstraints,
    SchedulingRequest,
    SchedulingUrgency,
    TimeSlot,
)

from .conftest import MockAgentRuntime


class TestAvailabilityChecking:
    def test_is_available_weekday_business_hours(
        self, scheduling_service: SchedulingService, sample_availability: Availability
    ) -> None:
        # Monday 10:00 AM ET (15:00 UTC)
        dt = datetime(2025, 1, 20, 15, 0, 0, tzinfo=timezone.utc)
        assert scheduling_service.is_available_at(sample_availability, dt) is True

    def test_is_not_available_weekend(
        self, scheduling_service: SchedulingService, sample_availability: Availability
    ) -> None:
        # Saturday 10:00 AM ET (15:00 UTC)
        dt = datetime(2025, 1, 18, 15, 0, 0, tzinfo=timezone.utc)
        assert scheduling_service.is_available_at(sample_availability, dt) is False

    def test_is_not_available_too_early(
        self, scheduling_service: SchedulingService, sample_availability: Availability
    ) -> None:
        # Monday 7:00 AM ET (12:00 UTC)
        dt = datetime(2025, 1, 20, 12, 0, 0, tzinfo=timezone.utc)
        assert scheduling_service.is_available_at(sample_availability, dt) is False

    def test_exception_unavailable(
        self, scheduling_service: SchedulingService
    ) -> None:
        avail = Availability(
            time_zone="UTC",
            weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020)],
            exceptions=[AvailabilityException(date="2025-01-20", unavailable=True)],
        )
        dt = datetime(2025, 1, 20, 10, 0, 0, tzinfo=timezone.utc)
        assert scheduling_service.is_available_at(avail, dt) is False

    def test_exception_override_times(
        self, scheduling_service: SchedulingService
    ) -> None:
        avail = Availability(
            time_zone="UTC",
            weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020)],
            exceptions=[
                AvailabilityException(date="2025-01-20", start_minutes=600, end_minutes=720)
            ],
        )
        # 10:00 UTC = 600 minutes -> within exception window
        dt = datetime(2025, 1, 20, 10, 0, 0, tzinfo=timezone.utc)
        assert scheduling_service.is_available_at(avail, dt) is True

        # 13:00 UTC = 780 minutes -> outside exception window
        dt2 = datetime(2025, 1, 20, 13, 0, 0, tzinfo=timezone.utc)
        assert scheduling_service.is_available_at(avail, dt2) is False


class TestAvailabilityPersistence:
    @pytest.mark.asyncio
    async def test_save_and_get(
        self, scheduling_service: SchedulingService, sample_availability: Availability
    ) -> None:
        entity_id = str(uuid.uuid4())
        await scheduling_service.save_availability(entity_id, sample_availability)
        result = await scheduling_service.get_availability(entity_id)

        assert result is not None
        assert result.time_zone == "America/New_York"
        assert len(result.weekly) == 5

    @pytest.mark.asyncio
    async def test_get_nonexistent(self, scheduling_service: SchedulingService) -> None:
        result = await scheduling_service.get_availability("nonexistent-id")
        assert result is None


class TestSlotFinding:
    @pytest.mark.asyncio
    async def test_find_slots_single_participant(
        self, scheduling_service: SchedulingService
    ) -> None:
        participant = Participant(
            entity_id=str(uuid.uuid4()),
            name="Alice",
            availability=Availability(
                time_zone="UTC",
                weekly=[
                    AvailabilityWindow(day=d, start_minutes=540, end_minutes=1020)
                    for d in [DayOfWeek.MON, DayOfWeek.TUE, DayOfWeek.WED, DayOfWeek.THU, DayOfWeek.FRI]
                ],
            ),
        )

        request = SchedulingRequest(
            id=str(uuid.uuid4()),
            room_id=str(uuid.uuid4()),
            title="Solo Meeting",
            participants=[participant],
            constraints=SchedulingConstraints(
                min_duration_minutes=30,
                preferred_duration_minutes=30,
                max_days_out=7,
            ),
            urgency=SchedulingUrgency.FLEXIBLE,
            created_at=1700000000000,
        )

        result = await scheduling_service.find_available_slots(request)
        assert result.success is True
        assert len(result.proposed_slots) > 0
        assert len(result.proposed_slots) <= 3

    @pytest.mark.asyncio
    async def test_find_slots_no_participants(
        self, scheduling_service: SchedulingService
    ) -> None:
        request = SchedulingRequest(
            id=str(uuid.uuid4()),
            room_id=str(uuid.uuid4()),
            title="Empty Meeting",
            participants=[],
            constraints=SchedulingConstraints(),
            created_at=1700000000000,
        )

        result = await scheduling_service.find_available_slots(request)
        assert result.success is False
        assert result.failure_reason == "No participants specified"

    @pytest.mark.asyncio
    async def test_find_slots_no_overlap(
        self, scheduling_service: SchedulingService
    ) -> None:
        alice = Participant(
            entity_id=str(uuid.uuid4()),
            name="Alice",
            availability=Availability(
                time_zone="UTC",
                weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=600)],
            ),
        )
        bob = Participant(
            entity_id=str(uuid.uuid4()),
            name="Bob",
            availability=Availability(
                time_zone="UTC",
                weekly=[AvailabilityWindow(day=DayOfWeek.TUE, start_minutes=540, end_minutes=600)],
            ),
        )

        request = SchedulingRequest(
            id=str(uuid.uuid4()),
            room_id=str(uuid.uuid4()),
            title="No Overlap",
            participants=[alice, bob],
            constraints=SchedulingConstraints(min_duration_minutes=30, max_days_out=7),
            created_at=1700000000000,
        )

        result = await scheduling_service.find_available_slots(request)
        assert result.success is False
        assert result.conflicting_participants is not None

    @pytest.mark.asyncio
    async def test_slot_scoring_business_hours_bonus(
        self, scheduling_service: SchedulingService
    ) -> None:
        participant = Participant(
            entity_id=str(uuid.uuid4()),
            name="Alice",
            availability=Availability(
                time_zone="UTC",
                weekly=[
                    AvailabilityWindow(day=d, start_minutes=480, end_minutes=1200)
                    for d in [DayOfWeek.MON, DayOfWeek.TUE, DayOfWeek.WED, DayOfWeek.THU, DayOfWeek.FRI]
                ],
            ),
        )

        request = SchedulingRequest(
            id=str(uuid.uuid4()),
            room_id=str(uuid.uuid4()),
            title="Scored Meeting",
            participants=[participant],
            constraints=SchedulingConstraints(
                min_duration_minutes=30,
                preferred_duration_minutes=30,
                max_days_out=14,
            ),
            urgency=SchedulingUrgency.FLEXIBLE,
            created_at=1700000000000,
        )

        result = await scheduling_service.find_available_slots(request)
        assert result.success is True
        # Top slots should have business-hours bonus
        for slot in result.proposed_slots:
            assert slot.score > 0


class TestDayIntersection:
    def test_simple_overlap(self, scheduling_service: SchedulingService) -> None:
        availabilities = [
            {
                "participant": Participant(
                    entity_id="a", name="A",
                    availability=Availability(
                        time_zone="UTC",
                        weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020)],
                    ),
                ),
                "availability": Availability(
                    time_zone="UTC",
                    weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020)],
                ),
            },
            {
                "participant": Participant(
                    entity_id="b", name="B",
                    availability=Availability(
                        time_zone="UTC",
                        weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=600, end_minutes=960)],
                    ),
                ),
                "availability": Availability(
                    time_zone="UTC",
                    weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=600, end_minutes=960)],
                ),
            },
        ]

        result = scheduling_service._find_day_intersection(
            availabilities, DayOfWeek.MON, "2025-01-20", 30
        )
        assert len(result) == 1
        assert result[0]["start"] == 600
        assert result[0]["end"] == 960

    def test_no_overlap(self, scheduling_service: SchedulingService) -> None:
        availabilities = [
            {
                "participant": Participant(
                    entity_id="a", name="A",
                    availability=Availability(
                        time_zone="UTC",
                        weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=600)],
                    ),
                ),
                "availability": Availability(
                    time_zone="UTC",
                    weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=600)],
                ),
            },
            {
                "participant": Participant(
                    entity_id="b", name="B",
                    availability=Availability(
                        time_zone="UTC",
                        weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=660, end_minutes=720)],
                    ),
                ),
                "availability": Availability(
                    time_zone="UTC",
                    weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=660, end_minutes=720)],
                ),
            },
        ]

        result = scheduling_service._find_day_intersection(
            availabilities, DayOfWeek.MON, "2025-01-20", 30
        )
        assert len(result) == 0

    def test_exception_unavailable(self, scheduling_service: SchedulingService) -> None:
        availabilities = [
            {
                "participant": Participant(
                    entity_id="a", name="A",
                    availability=Availability(
                        time_zone="UTC",
                        weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020)],
                        exceptions=[AvailabilityException(date="2025-01-20", unavailable=True)],
                    ),
                ),
                "availability": Availability(
                    time_zone="UTC",
                    weekly=[AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020)],
                    exceptions=[AvailabilityException(date="2025-01-20", unavailable=True)],
                ),
            },
        ]

        result = scheduling_service._find_day_intersection(
            availabilities, DayOfWeek.MON, "2025-01-20", 30
        )
        assert len(result) == 0


class TestMeetingCRUD:
    @pytest.mark.asyncio
    async def test_create_and_get_meeting(
        self, scheduling_service: SchedulingService, sample_scheduling_request: SchedulingRequest
    ) -> None:
        slot = TimeSlot(start="2030-01-20T15:00:00Z", end="2030-01-20T16:00:00Z", time_zone="UTC")
        meeting = await scheduling_service.create_meeting(
            sample_scheduling_request, slot, {"type": "virtual", "video_url": "https://meet.example.com"}
        )

        assert meeting.id
        assert meeting.title == "Test Meeting"
        assert meeting.status == MeetingStatus.PROPOSED
        assert len(meeting.participants) == 2
        assert meeting.participants[0].role == ParticipantRole.ORGANIZER
        assert meeting.participants[1].role == ParticipantRole.REQUIRED

        retrieved = await scheduling_service.get_meeting(meeting.id)
        assert retrieved is not None
        assert retrieved.id == meeting.id

    @pytest.mark.asyncio
    async def test_confirm_participant(
        self, scheduling_service: SchedulingService, sample_scheduling_request: SchedulingRequest
    ) -> None:
        slot = TimeSlot(start="2030-01-20T15:00:00Z", end="2030-01-20T16:00:00Z", time_zone="UTC")
        meeting = await scheduling_service.create_meeting(
            sample_scheduling_request, slot, {"type": "virtual"}
        )

        entity_id = sample_scheduling_request.participants[0].entity_id
        updated = await scheduling_service.confirm_participant(meeting.id, entity_id)
        p = next(p for p in updated.participants if p.entity_id == entity_id)
        assert p.confirmed is True
        assert p.confirmed_at is not None

    @pytest.mark.asyncio
    async def test_confirm_all_required_changes_status(
        self, scheduling_service: SchedulingService, sample_scheduling_request: SchedulingRequest
    ) -> None:
        slot = TimeSlot(start="2030-01-20T15:00:00Z", end="2030-01-20T16:00:00Z", time_zone="UTC")
        meeting = await scheduling_service.create_meeting(
            sample_scheduling_request, slot, {"type": "virtual"}
        )

        for p in sample_scheduling_request.participants:
            meeting = await scheduling_service.confirm_participant(meeting.id, p.entity_id)

        assert meeting.status == MeetingStatus.CONFIRMED

    @pytest.mark.asyncio
    async def test_decline_required_triggers_rescheduling(
        self, scheduling_service: SchedulingService, sample_scheduling_request: SchedulingRequest
    ) -> None:
        slot = TimeSlot(start="2030-01-20T15:00:00Z", end="2030-01-20T16:00:00Z", time_zone="UTC")
        meeting = await scheduling_service.create_meeting(
            sample_scheduling_request, slot, {"type": "virtual"}
        )

        entity_id = sample_scheduling_request.participants[0].entity_id
        updated = await scheduling_service.decline_participant(
            meeting.id, entity_id, "Conflict"
        )
        assert updated.status == MeetingStatus.RESCHEDULING
        assert "Conflict" in (updated.cancellation_reason or "")

    @pytest.mark.asyncio
    async def test_cancel_meeting(
        self, scheduling_service: SchedulingService, sample_scheduling_request: SchedulingRequest
    ) -> None:
        slot = TimeSlot(start="2030-01-20T15:00:00Z", end="2030-01-20T16:00:00Z", time_zone="UTC")
        meeting = await scheduling_service.create_meeting(
            sample_scheduling_request, slot, {"type": "virtual"}
        )

        cancelled = await scheduling_service.cancel_meeting(meeting.id, "No longer needed")
        assert cancelled.status == MeetingStatus.CANCELLED
        assert cancelled.cancellation_reason == "No longer needed"

    @pytest.mark.asyncio
    async def test_reschedule_meeting(
        self, scheduling_service: SchedulingService, sample_scheduling_request: SchedulingRequest
    ) -> None:
        slot = TimeSlot(start="2030-01-20T15:00:00Z", end="2030-01-20T16:00:00Z", time_zone="UTC")
        meeting = await scheduling_service.create_meeting(
            sample_scheduling_request, slot, {"type": "virtual"}
        )

        new_slot = TimeSlot(start="2030-01-21T15:00:00Z", end="2030-01-21T16:00:00Z", time_zone="UTC")
        rescheduled = await scheduling_service.reschedule_meeting(meeting.id, new_slot, "Better time")

        assert rescheduled.slot.start == "2030-01-21T15:00:00Z"
        assert rescheduled.status == MeetingStatus.PROPOSED
        assert rescheduled.reschedule_count == 1
        assert all(not p.confirmed for p in rescheduled.participants)

    @pytest.mark.asyncio
    async def test_meeting_not_found(self, scheduling_service: SchedulingService) -> None:
        with pytest.raises(MeetingNotFoundError):
            await scheduling_service.confirm_participant("nonexistent", "entity-id")

    @pytest.mark.asyncio
    async def test_participant_not_found(
        self, scheduling_service: SchedulingService, sample_scheduling_request: SchedulingRequest
    ) -> None:
        slot = TimeSlot(start="2030-01-20T15:00:00Z", end="2030-01-20T16:00:00Z", time_zone="UTC")
        meeting = await scheduling_service.create_meeting(
            sample_scheduling_request, slot, {"type": "virtual"}
        )

        with pytest.raises(ParticipantNotFoundError):
            await scheduling_service.confirm_participant(meeting.id, "nonexistent-entity")


class TestCalendarInvites:
    @pytest.mark.asyncio
    async def test_generate_invite(
        self, scheduling_service: SchedulingService, sample_meeting: Meeting
    ) -> None:
        invite = scheduling_service.generate_calendar_invite(
            sample_meeting, "alice@example.com", "Alice"
        )

        assert invite.recipient_email == "alice@example.com"
        assert invite.recipient_name == "Alice"
        assert "BEGIN:VCALENDAR" in invite.ics
        assert invite.event.uid == sample_meeting.id
        assert invite.event.title == "Coffee Chat"

    @pytest.mark.asyncio
    async def test_send_invites(
        self, scheduling_service: SchedulingService, sample_meeting: Meeting
    ) -> None:
        invites = await scheduling_service.send_calendar_invites(sample_meeting)
        assert len(invites) == 2  # Alice and Bob both have emails


class TestFormatSlot:
    def test_format_slot(self, scheduling_service: SchedulingService) -> None:
        slot = TimeSlot(
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="America/New_York",
        )
        formatted = scheduling_service.format_slot(slot)
        assert "Mon" in formatted
        assert "Jan" in formatted
        assert "10:00" in formatted  # 15:00 UTC = 10:00 ET


class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_healthy(self, scheduling_service: SchedulingService) -> None:
        result = await scheduling_service.health_check()
        assert result["healthy"] is True
        assert result["issues"] == []
