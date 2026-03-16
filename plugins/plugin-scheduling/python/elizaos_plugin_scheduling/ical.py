"""
ICS (iCalendar) file generation and parsing utilities.

Generates RFC 5545 compliant iCalendar files for calendar invites.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from .types import CalendarEvent, CalendarEventAttendee, ParticipantRole


def escape_ics(s: str) -> str:
    """Escape special characters for ICS format."""
    return (
        s.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def unescape_ics(s: str) -> str:
    """Unescape ICS special characters."""
    return (
        s.replace("\\n", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
    )


def format_ics_date(iso_string: str) -> str:
    """Format a date for ICS (YYYYMMDDTHHMMSSZ)."""
    return re.sub(r"\.\d{3}", "", re.sub(r"[-:]", "", iso_string))


def parse_ics_date(ics_date: str) -> str:
    """Parse ICS date format to ISO string."""
    match = re.match(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$", ics_date)
    if match:
        year, month, day, hour, minute, second = match.groups()
        return f"{year}-{month}-{day}T{hour}:{minute}:{second}Z"
    return ics_date


def ics_role(role: ParticipantRole) -> str:
    """Map participant role to ICS role."""
    if role == ParticipantRole.OPTIONAL:
        return "OPT-PARTICIPANT"
    return "REQ-PARTICIPANT"


def fold_line(line: str) -> str:
    """Fold long lines per RFC 5545 (max 75 octets per line)."""
    max_length = 75
    if len(line) <= max_length:
        return line

    lines: list[str] = []
    remaining = line

    while remaining:
        if not lines:
            lines.append(remaining[:max_length])
            remaining = remaining[max_length:]
        else:
            # Continuation lines start with a space
            lines.append(" " + remaining[: max_length - 1])
            remaining = remaining[max_length - 1 :]

    return "\r\n".join(lines)


def generate_ics(event: CalendarEvent) -> str:
    """Generate ICS content for a calendar event."""
    lines: list[str] = []

    # Begin calendar
    lines.append("BEGIN:VCALENDAR")
    lines.append("VERSION:2.0")
    lines.append("PRODID:-//elizaOS//SchedulingPlugin//EN")
    lines.append("CALSCALE:GREGORIAN")
    lines.append("METHOD:REQUEST")

    # Begin event
    lines.append("BEGIN:VEVENT")

    # Required properties
    lines.append(f"UID:{event.uid}")
    now_stamp = format_ics_date(
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    )
    lines.append(f"DTSTAMP:{now_stamp}")
    lines.append(f"DTSTART:{format_ics_date(event.start)}")
    lines.append(f"DTEND:{format_ics_date(event.end)}")
    lines.append(f"SUMMARY:{escape_ics(event.title)}")

    # Optional properties
    if event.description:
        lines.append(f"DESCRIPTION:{escape_ics(event.description)}")

    if event.location:
        lines.append(f"LOCATION:{escape_ics(event.location)}")

    if event.url:
        lines.append(f"URL:{event.url}")

    # Organizer
    if event.organizer:
        lines.append(
            f"ORGANIZER;CN={escape_ics(event.organizer.name)}:mailto:{event.organizer.email}"
        )

    # Attendees
    if event.attendees:
        for attendee in event.attendees:
            role = ics_role(attendee.role)
            lines.append(
                f"ATTENDEE;ROLE={role};PARTSTAT=NEEDS-ACTION;"
                f"CN={escape_ics(attendee.name)}:mailto:{attendee.email}"
            )

    # Reminders/Alarms
    if event.reminder_minutes:
        for minutes in event.reminder_minutes:
            lines.append("BEGIN:VALARM")
            lines.append("ACTION:DISPLAY")
            lines.append(f"DESCRIPTION:{escape_ics(event.title)}")
            lines.append(f"TRIGGER:-PT{minutes}M")
            lines.append("END:VALARM")

    # Status
    lines.append("STATUS:CONFIRMED")
    lines.append("SEQUENCE:0")

    # End event
    lines.append("END:VEVENT")

    # End calendar
    lines.append("END:VCALENDAR")

    # Fold long lines and join with CRLF
    return "\r\n".join(fold_line(line) for line in lines)


def parse_ics(ics: str) -> list[CalendarEvent]:
    """Parse an ICS file and extract events (basic parser)."""
    events: list[CalendarEvent] = []
    lines = re.split(r"\r?\n", ics)

    current_event: Optional[dict] = None
    current_line = ""

    for line in lines:
        # Handle line folding (continuation lines start with space or tab)
        if line.startswith(" ") or line.startswith("\t"):
            current_line += line[1:]
            continue

        # Process the previous line
        if current_line and current_event is not None:
            _process_line(current_line, current_event)

        current_line = line

        # Check for event boundaries
        if line == "BEGIN:VEVENT":
            current_event = {}
        elif line == "END:VEVENT" and current_event is not None:
            if all(
                k in current_event for k in ("uid", "start", "end", "title")
            ):
                events.append(
                    CalendarEvent(
                        uid=current_event["uid"],
                        title=current_event["title"],
                        start=current_event["start"],
                        end=current_event["end"],
                        time_zone=current_event.get("time_zone", "UTC"),
                        description=current_event.get("description"),
                        location=current_event.get("location"),
                        url=current_event.get("url"),
                    )
                )
            current_event = None

    return events


def _process_line(line: str, event: dict) -> None:
    """Process a single ICS property line."""
    colon_index = line.find(":")
    if colon_index == -1:
        return

    key_part = line[:colon_index]
    value = line[colon_index + 1 :]

    # Handle properties with parameters
    semi_index = key_part.find(";")
    key = key_part[:semi_index] if semi_index != -1 else key_part

    mapping = {
        "UID": "uid",
        "SUMMARY": ("title", True),
        "DESCRIPTION": ("description", True),
        "DTSTART": ("start", False, True),
        "DTEND": ("end", False, True),
        "LOCATION": ("location", True),
        "URL": "url",
    }

    spec = mapping.get(key)
    if spec is None:
        return
    if isinstance(spec, str):
        event[spec] = value
    elif len(spec) == 2:
        field_name, do_unescape = spec
        event[field_name] = unescape_ics(value) if do_unescape else value
    elif len(spec) == 3:
        field_name, _, is_date = spec
        event[field_name] = parse_ics_date(value) if is_date else value
