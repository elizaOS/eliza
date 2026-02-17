"""Tests for ICS generation and parsing."""

from __future__ import annotations

from elizaos_plugin_scheduling.ical import (
    escape_ics,
    fold_line,
    format_ics_date,
    generate_ics,
    parse_ics,
    parse_ics_date,
    unescape_ics,
)
from elizaos_plugin_scheduling.types import (
    CalendarEvent,
    CalendarEventAttendee,
    CalendarEventOrganizer,
    ParticipantRole,
)


class TestEscapeIcs:
    def test_backslash(self) -> None:
        assert escape_ics("a\\b") == "a\\\\b"

    def test_semicolon(self) -> None:
        assert escape_ics("a;b") == "a\\;b"

    def test_comma(self) -> None:
        assert escape_ics("a,b") == "a\\,b"

    def test_newline(self) -> None:
        assert escape_ics("a\nb") == "a\\nb"

    def test_combined(self) -> None:
        assert escape_ics("a\\b;c,d\ne") == "a\\\\b\\;c\\,d\\ne"


class TestUnescapeIcs:
    def test_roundtrip(self) -> None:
        original = "Hello\\, World;Test\nNewline"
        assert unescape_ics(escape_ics(original)) == original


class TestFormatIcsDate:
    def test_basic(self) -> None:
        assert format_ics_date("2025-01-20T15:00:00Z") == "20250120T150000Z"

    def test_with_milliseconds(self) -> None:
        assert format_ics_date("2025-01-20T15:00:00.000Z") == "20250120T150000Z"


class TestParseIcsDate:
    def test_basic(self) -> None:
        assert parse_ics_date("20250120T150000Z") == "2025-01-20T15:00:00Z"

    def test_without_z(self) -> None:
        assert parse_ics_date("20250120T150000") == "2025-01-20T15:00:00Z"

    def test_unrecognized(self) -> None:
        assert parse_ics_date("not-a-date") == "not-a-date"


class TestFoldLine:
    def test_short_line(self) -> None:
        line = "SHORT"
        assert fold_line(line) == "SHORT"

    def test_long_line(self) -> None:
        line = "A" * 100
        folded = fold_line(line)
        # First line: 75 chars, continuation: " " + 74 chars
        assert "\r\n" in folded
        parts = folded.split("\r\n")
        assert len(parts[0]) == 75
        assert parts[1].startswith(" ")

    def test_exact_75(self) -> None:
        line = "B" * 75
        assert fold_line(line) == line


class TestGenerateIcs:
    def test_basic_event(self) -> None:
        event = CalendarEvent(
            uid="test-uid-123",
            title="Team Standup",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T15:30:00Z",
            time_zone="UTC",
        )
        ics = generate_ics(event)

        assert "BEGIN:VCALENDAR" in ics
        assert "END:VCALENDAR" in ics
        assert "BEGIN:VEVENT" in ics
        assert "END:VEVENT" in ics
        assert "UID:test-uid-123" in ics
        assert "SUMMARY:Team Standup" in ics
        assert "DTSTART:20250120T150000Z" in ics
        assert "DTEND:20250120T153000Z" in ics
        assert "VERSION:2.0" in ics
        assert "PRODID:-//elizaOS//SchedulingPlugin//EN" in ics

    def test_with_description_and_location(self) -> None:
        event = CalendarEvent(
            uid="test-uid",
            title="Review",
            description="Quarterly review meeting",
            location="Conference Room A",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="UTC",
        )
        ics = generate_ics(event)
        assert "DESCRIPTION:Quarterly review meeting" in ics
        assert "LOCATION:Conference Room A" in ics

    def test_with_organizer_and_attendees(self) -> None:
        event = CalendarEvent(
            uid="test-uid",
            title="Planning",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="UTC",
            organizer=CalendarEventOrganizer(name="Alice", email="alice@example.com"),
            attendees=[
                CalendarEventAttendee(
                    name="Bob", email="bob@example.com", role=ParticipantRole.REQUIRED
                ),
                CalendarEventAttendee(
                    name="Carol", email="carol@example.com", role=ParticipantRole.OPTIONAL
                ),
            ],
        )
        ics = generate_ics(event)
        assert "ORGANIZER;CN=Alice:mailto:alice@example.com" in ics
        assert "ROLE=REQ-PARTICIPANT" in ics
        assert "ROLE=OPT-PARTICIPANT" in ics
        assert "mailto:bob@example.com" in ics
        assert "mailto:carol@example.com" in ics

    def test_with_reminders(self) -> None:
        event = CalendarEvent(
            uid="test-uid",
            title="Meeting",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="UTC",
            reminder_minutes=[1440, 120],
        )
        ics = generate_ics(event)
        assert "BEGIN:VALARM" in ics
        assert "TRIGGER:-PT1440M" in ics
        assert "TRIGGER:-PT120M" in ics

    def test_with_url(self) -> None:
        event = CalendarEvent(
            uid="test-uid",
            title="Virtual Meeting",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="UTC",
            url="https://meet.example.com/abc",
        )
        ics = generate_ics(event)
        assert "URL:https://meet.example.com/abc" in ics

    def test_crlf_line_endings(self) -> None:
        event = CalendarEvent(
            uid="uid",
            title="Test",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="UTC",
        )
        ics = generate_ics(event)
        # All newlines should be CRLF
        lines = ics.split("\r\n")
        assert len(lines) > 5


class TestParseIcs:
    def test_roundtrip(self) -> None:
        event = CalendarEvent(
            uid="roundtrip-uid",
            title="Roundtrip Test",
            description="Testing roundtrip",
            start="2025-01-20T15:00:00Z",
            end="2025-01-20T16:00:00Z",
            time_zone="UTC",
            location="Conference Room B",
        )
        ics = generate_ics(event)
        parsed = parse_ics(ics)

        assert len(parsed) == 1
        p = parsed[0]
        assert p.uid == "roundtrip-uid"
        assert p.title == "Roundtrip Test"
        assert p.description == "Testing roundtrip"
        assert "2025-01-20" in p.start
        assert "15:00:00" in p.start
        assert p.location == "Conference Room B"

    def test_empty_ics(self) -> None:
        result = parse_ics("")
        assert result == []

    def test_no_events(self) -> None:
        result = parse_ics("BEGIN:VCALENDAR\r\nEND:VCALENDAR")
        assert result == []

    def test_incomplete_event(self) -> None:
        ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:test\r\nEND:VEVENT\r\nEND:VCALENDAR"
        result = parse_ics(ics)
        assert len(result) == 0  # Missing required fields
