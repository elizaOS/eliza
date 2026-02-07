"""Tests for action definitions and validation."""

from __future__ import annotations

from elizaos_plugin_scheduling.actions.confirm_meeting import (
    _validate_confirm_meeting,
    confirm_meeting_action,
)
from elizaos_plugin_scheduling.actions.schedule_meeting import (
    _validate_schedule_meeting,
    format_proposed_slots,
    parse_meeting_request,
    schedule_meeting_action,
)
from elizaos_plugin_scheduling.actions.set_availability import (
    _validate_set_availability,
    format_day,
    format_time,
    parse_availability_text,
    parse_days,
    parse_time_to_minutes,
    set_availability_action,
)
from elizaos_plugin_scheduling.types import (
    DayOfWeek,
    ProposedSlot,
    TimeSlot,
)


# ============================================================================
# SCHEDULE_MEETING
# ============================================================================


class TestParseMeetingRequest:
    def test_extract_title(self) -> None:
        result = parse_meeting_request("Schedule a meeting about Q4 planning")
        assert result.get("title") == "Q4 planning"

    def test_extract_duration_minutes(self) -> None:
        result = parse_meeting_request("Book a 45 minute call")
        assert result["duration"] == 45

    def test_extract_duration_hours(self) -> None:
        result = parse_meeting_request("Set up a 2 hour meeting")
        assert result["duration"] == 120

    def test_urgency_urgent(self) -> None:
        result = parse_meeting_request("I need a meeting asap")
        assert result["urgency"] == "urgent"

    def test_urgency_soon(self) -> None:
        result = parse_meeting_request("Let's meet this week")
        assert result["urgency"] == "soon"

    def test_urgency_flexible(self) -> None:
        result = parse_meeting_request("Can we meet sometime?")
        assert result["urgency"] == "flexible"


class TestFormatProposedSlots:
    def test_empty_slots(self) -> None:
        result = format_proposed_slots([])
        assert "couldn't find" in result

    def test_with_slots(self) -> None:
        slots = [
            ProposedSlot(
                slot=TimeSlot(
                    start="2025-01-20T15:00:00Z",
                    end="2025-01-20T15:30:00Z",
                    time_zone="UTC",
                ),
                score=100.0,
                reasons=["Standard business hours"],
            ),
        ]
        result = format_proposed_slots(slots)
        assert "1." in result
        assert "Standard business hours" in result
        assert "Which option" in result


class TestScheduleMeetingAction:
    def test_metadata(self) -> None:
        assert schedule_meeting_action["name"] == "SCHEDULE_MEETING"
        assert "BOOK_MEETING" in schedule_meeting_action["similes"]
        assert len(schedule_meeting_action["examples"]) == 2

    def test_validate_schedule(self) -> None:
        class Msg:
            class content:
                text = "Can you schedule a meeting?"
        assert _validate_schedule_meeting(None, Msg()) is True

    def test_validate_book(self) -> None:
        class Msg:
            class content:
                text = "I need to book a room"
        assert _validate_schedule_meeting(None, Msg()) is True

    def test_validate_nice_to_meet(self) -> None:
        class Msg:
            class content:
                text = "Nice to meet you!"
        assert _validate_schedule_meeting(None, Msg()) is False

    def test_validate_unrelated(self) -> None:
        class Msg:
            class content:
                text = "What's the weather like?"
        assert _validate_schedule_meeting(None, Msg()) is False


# ============================================================================
# CONFIRM_MEETING
# ============================================================================


class TestConfirmMeetingAction:
    def test_metadata(self) -> None:
        assert confirm_meeting_action["name"] == "CONFIRM_MEETING"
        assert "RSVP_YES" in confirm_meeting_action["similes"]
        assert len(confirm_meeting_action["examples"]) == 2

    def test_validate_confirm(self) -> None:
        class Msg:
            class content:
                text = "I confirm the meeting"
        assert _validate_confirm_meeting(None, Msg()) is True

    def test_validate_decline(self) -> None:
        class Msg:
            class content:
                text = "I need to decline the meeting"
        assert _validate_confirm_meeting(None, Msg()) is True

    def test_validate_rsvp(self) -> None:
        class Msg:
            class content:
                text = "RSVP to the event"
        assert _validate_confirm_meeting(None, Msg()) is True

    def test_validate_be_there(self) -> None:
        class Msg:
            class content:
                text = "Yes, I'll be there"
        assert _validate_confirm_meeting(None, Msg()) is True

    def test_validate_cant_make_it(self) -> None:
        class Msg:
            class content:
                text = "Sorry, I can't make it"
        assert _validate_confirm_meeting(None, Msg()) is True

    def test_validate_unrelated(self) -> None:
        class Msg:
            class content:
                text = "What time is it?"
        assert _validate_confirm_meeting(None, Msg()) is False


# ============================================================================
# SET_AVAILABILITY
# ============================================================================


class TestParseTimeToMinutes:
    def test_24h_format(self) -> None:
        assert parse_time_to_minutes("14:30") == 870

    def test_12h_am(self) -> None:
        assert parse_time_to_minutes("9am") == 540

    def test_12h_pm(self) -> None:
        assert parse_time_to_minutes("5pm") == 1020

    def test_12h_with_minutes(self) -> None:
        assert parse_time_to_minutes("10:30am") == 630

    def test_noon(self) -> None:
        assert parse_time_to_minutes("12pm") == 720

    def test_midnight_am(self) -> None:
        assert parse_time_to_minutes("12am") == 0

    def test_invalid(self) -> None:
        assert parse_time_to_minutes("not-a-time") is None


class TestParseDays:
    def test_weekdays(self) -> None:
        days = parse_days("weekdays")
        assert len(days) == 5
        assert DayOfWeek.MON in days
        assert DayOfWeek.SAT not in days

    def test_weekends(self) -> None:
        days = parse_days("weekends")
        assert len(days) == 2
        assert DayOfWeek.SAT in days
        assert DayOfWeek.SUN in days

    def test_daily(self) -> None:
        days = parse_days("everyday")
        assert len(days) == 7

    def test_single_day(self) -> None:
        assert parse_days("monday") == [DayOfWeek.MON]
        assert parse_days("fri") == [DayOfWeek.FRI]

    def test_unknown(self) -> None:
        assert parse_days("notaday") == []


class TestParseAvailabilityText:
    def test_weekdays_time_range(self) -> None:
        result = parse_availability_text("weekdays 9am to 5pm")
        assert result is not None
        assert len(result["windows"]) == 5
        for w in result["windows"]:
            assert w.start_minutes == 540
            assert w.end_minutes == 1020

    def test_single_day_preset(self) -> None:
        result = parse_availability_text("Monday mornings")
        assert result is not None
        assert len(result["windows"]) == 1
        assert result["windows"][0].day == DayOfWeek.MON
        assert result["windows"][0].start_minutes == 540
        assert result["windows"][0].end_minutes == 720

    def test_time_zone_extraction(self) -> None:
        result = parse_availability_text("weekdays 9am to 5pm timezone America/Chicago")
        assert result is not None
        assert result["time_zone"] == "America/Chicago"

    def test_fallback_mornings(self) -> None:
        result = parse_availability_text("I'm free mornings")
        assert result is not None
        assert len(result["windows"]) == 5  # Weekdays assumed

    def test_unparseable(self) -> None:
        result = parse_availability_text("Let's talk later")
        assert result is None


class TestFormatTime:
    def test_am(self) -> None:
        assert format_time(540) == "9am"

    def test_pm(self) -> None:
        assert format_time(1020) == "5pm"

    def test_with_minutes(self) -> None:
        assert format_time(630) == "10:30am"

    def test_noon(self) -> None:
        assert format_time(720) == "12pm"

    def test_midnight(self) -> None:
        assert format_time(0) == "12am"


class TestFormatDay:
    def test_all_days(self) -> None:
        assert format_day(DayOfWeek.MON) == "Monday"
        assert format_day(DayOfWeek.SUN) == "Sunday"


class TestSetAvailabilityAction:
    def test_metadata(self) -> None:
        assert set_availability_action["name"] == "SET_AVAILABILITY"
        assert "UPDATE_AVAILABILITY" in set_availability_action["similes"]
        assert len(set_availability_action["examples"]) == 2

    def test_validate_available(self) -> None:
        class Msg:
            class content:
                text = "I'm available weekdays"
        assert _validate_set_availability(None, Msg()) is True

    def test_validate_free(self) -> None:
        class Msg:
            class content:
                text = "I'm free on Monday"
        assert _validate_set_availability(None, Msg()) is True

    def test_validate_morning(self) -> None:
        class Msg:
            class content:
                text = "mornings work best for me"
        assert _validate_set_availability(None, Msg()) is True

    def test_validate_unrelated(self) -> None:
        class Msg:
            class content:
                text = "What is Python?"
        assert _validate_set_availability(None, Msg()) is False
