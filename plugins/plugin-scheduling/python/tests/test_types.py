"""Tests for type definitions."""

from __future__ import annotations

import pytest

from elizaos_plugin_scheduling.types import (
    Availability,
    AvailabilityException,
    AvailabilityWindow,
    CalendarEvent,
    CalendarEventAttendee,
    CalendarEventOrganizer,
    DayOfWeek,
    LocationType,
    Meeting,
    MeetingLocation,
    MeetingParticipant,
    MeetingStatus,
    Participant,
    ParticipantRole,
    ProposedSlot,
    Reminder,
    ReminderStatus,
    ReminderType,
    SchedulingConstraints,
    SchedulingRequest,
    SchedulingResult,
    SchedulingUrgency,
    TimeSlot,
)


class TestDayOfWeek:
    def test_values(self) -> None:
        assert DayOfWeek.MON == "mon"
        assert DayOfWeek.FRI == "fri"
        assert DayOfWeek.SUN == "sun"

    def test_all_days(self) -> None:
        days = list(DayOfWeek)
        assert len(days) == 7


class TestAvailabilityWindow:
    def test_creation(self) -> None:
        window = AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1020)
        assert window.day == DayOfWeek.MON
        assert window.start_minutes == 540
        assert window.end_minutes == 1020

    def test_invalid_start_minutes(self) -> None:
        with pytest.raises(ValueError, match="start_minutes"):
            AvailabilityWindow(day=DayOfWeek.MON, start_minutes=-1, end_minutes=1020)

    def test_invalid_end_minutes(self) -> None:
        with pytest.raises(ValueError, match="end_minutes"):
            AvailabilityWindow(day=DayOfWeek.MON, start_minutes=540, end_minutes=1440)


class TestAvailability:
    def test_creation(self) -> None:
        avail = Availability(time_zone="America/New_York")
        assert avail.time_zone == "America/New_York"
        assert avail.weekly == []
        assert avail.exceptions == []

    def test_with_windows(self) -> None:
        avail = Availability(
            time_zone="UTC",
            weekly=[
                AvailabilityWindow(day=DayOfWeek.MON, start_minutes=0, end_minutes=1439),
            ],
        )
        assert len(avail.weekly) == 1

    def test_with_exceptions(self) -> None:
        avail = Availability(
            time_zone="UTC",
            exceptions=[
                AvailabilityException(date="2025-01-01", unavailable=True, reason="Holiday"),
            ],
        )
        assert len(avail.exceptions) == 1
        assert avail.exceptions[0].unavailable is True


class TestTimeSlot:
    def test_creation(self) -> None:
        slot = TimeSlot(start="2025-01-20T15:00:00Z", end="2025-01-20T16:00:00Z", time_zone="UTC")
        assert slot.start == "2025-01-20T15:00:00Z"


class TestParticipant:
    def test_creation(self) -> None:
        p = Participant(
            entity_id="abc-123",
            name="Alice",
            availability=Availability(time_zone="UTC"),
        )
        assert p.name == "Alice"
        assert p.priority is None


class TestMeetingParticipant:
    def test_creation(self) -> None:
        mp = MeetingParticipant(
            entity_id="abc-123",
            name="Alice",
            role=ParticipantRole.ORGANIZER,
        )
        assert mp.confirmed is False
        assert mp.confirmed_at is None


class TestMeetingLocation:
    def test_virtual(self) -> None:
        loc = MeetingLocation(type=LocationType.VIRTUAL, video_url="https://meet.example.com")
        assert loc.type == LocationType.VIRTUAL

    def test_in_person(self) -> None:
        loc = MeetingLocation(type=LocationType.IN_PERSON, name="Coffee Shop", city="NYC")
        assert loc.name == "Coffee Shop"


class TestMeeting:
    def test_default_status(self) -> None:
        meeting = Meeting(
            id="m1",
            request_id="r1",
            room_id="room1",
            title="Test",
            slot=TimeSlot(start="2025-01-20T15:00:00Z", end="2025-01-20T16:00:00Z", time_zone="UTC"),
            location=MeetingLocation(type=LocationType.VIRTUAL),
            participants=[],
            status=MeetingStatus.PROPOSED,
            reschedule_count=0,
            created_at=1700000000000,
            updated_at=1700000000000,
        )
        assert meeting.status == MeetingStatus.PROPOSED
        assert meeting.reschedule_count == 0


class TestSchedulingResult:
    def test_success(self) -> None:
        result = SchedulingResult(
            success=True,
            proposed_slots=[
                ProposedSlot(
                    slot=TimeSlot(start="2025-01-20T15:00:00Z", end="2025-01-20T16:00:00Z", time_zone="UTC"),
                    score=100.0,
                    reasons=["Standard business hours"],
                ),
            ],
        )
        assert result.success
        assert len(result.proposed_slots) == 1

    def test_failure(self) -> None:
        result = SchedulingResult(success=False, failure_reason="No overlap")
        assert not result.success
        assert result.failure_reason == "No overlap"


class TestCalendarEvent:
    def test_creation(self) -> None:
        event = CalendarEvent(
            uid="test-uid",
            title="Test Meeting",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="UTC",
            organizer=CalendarEventOrganizer(name="Alice", email="alice@example.com"),
            attendees=[
                CalendarEventAttendee(name="Bob", email="bob@example.com", role=ParticipantRole.REQUIRED),
            ],
            reminder_minutes=[1440, 120],
        )
        assert event.uid == "test-uid"
        assert len(event.attendees) == 1


class TestReminder:
    def test_defaults(self) -> None:
        r = Reminder(
            id="r1",
            meeting_id="m1",
            participant_id="p1",
            scheduled_for="2025-01-20T13:00:00Z",
            type=ReminderType.EMAIL,
            message="Test",
            status=ReminderStatus.PENDING,
            created_at=1700000000000,
        )
        assert r.status == ReminderStatus.PENDING
        assert r.sent_at is None


class TestEnums:
    def test_meeting_statuses(self) -> None:
        statuses = list(MeetingStatus)
        assert len(statuses) == 8
        assert MeetingStatus.PROPOSED in statuses
        assert MeetingStatus.CANCELLED in statuses

    def test_urgency_levels(self) -> None:
        assert SchedulingUrgency.FLEXIBLE == "flexible"
        assert SchedulingUrgency.SOON == "soon"
        assert SchedulingUrgency.URGENT == "urgent"
