"""
SET_AVAILABILITY action.

Parses natural language availability ("weekdays 9-5", "monday afternoons")
and saves to scheduling service.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ..types import AvailabilityWindow, DayOfWeek


# ============================================================================
# PARSING HELPERS
# ============================================================================


DAY_NAMES: dict[str, DayOfWeek] = {
    "monday": DayOfWeek.MON, "mon": DayOfWeek.MON,
    "tuesday": DayOfWeek.TUE, "tue": DayOfWeek.TUE,
    "wednesday": DayOfWeek.WED, "wed": DayOfWeek.WED,
    "thursday": DayOfWeek.THU, "thu": DayOfWeek.THU,
    "friday": DayOfWeek.FRI, "fri": DayOfWeek.FRI,
    "saturday": DayOfWeek.SAT, "sat": DayOfWeek.SAT,
    "sunday": DayOfWeek.SUN, "sun": DayOfWeek.SUN,
}

TIME_PRESETS: dict[str, dict[str, int]] = {
    "morning": {"start": 540, "end": 720},
    "afternoon": {"start": 720, "end": 1020},
    "evening": {"start": 1020, "end": 1260},
    "business hours": {"start": 540, "end": 1020},
    "work hours": {"start": 540, "end": 1020},
}


def parse_time_to_minutes(time_str: str) -> Optional[int]:
    """Parse a time string to minutes from midnight."""
    normalized = time_str.lower().strip()

    # Try "HH:MM" 24-hour format
    match = re.match(r"^(\d{1,2}):(\d{2})$", normalized)
    if match:
        hours = int(match.group(1))
        minutes = int(match.group(2))
        if 0 <= hours < 24 and 0 <= minutes < 60:
            return hours * 60 + minutes

    # Try "H:MMam/pm" or "HHam/pm" format
    match = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$", normalized, re.IGNORECASE)
    if match:
        hours = int(match.group(1))
        minutes = int(match.group(2)) if match.group(2) else 0
        is_pm = match.group(3).lower() == "pm"

        if hours == 12:
            hours = 12 if is_pm else 0
        elif is_pm:
            hours += 12

        if 0 <= hours < 24 and 0 <= minutes < 60:
            return hours * 60 + minutes

    return None


def parse_days(day_str: str) -> list[DayOfWeek]:
    """Parse a day string to a list of DayOfWeek values."""
    normalized = day_str.lower().strip()

    if normalized in ("weekday", "weekdays"):
        return [DayOfWeek.MON, DayOfWeek.TUE, DayOfWeek.WED, DayOfWeek.THU, DayOfWeek.FRI]

    if normalized in ("weekend", "weekends"):
        return [DayOfWeek.SAT, DayOfWeek.SUN]

    if normalized in ("everyday", "every day", "daily"):
        return [
            DayOfWeek.MON, DayOfWeek.TUE, DayOfWeek.WED, DayOfWeek.THU,
            DayOfWeek.FRI, DayOfWeek.SAT, DayOfWeek.SUN,
        ]

    day = DAY_NAMES.get(normalized)
    return [day] if day else []


def parse_availability_text(
    text: str,
) -> Optional[dict[str, Any]]:
    """Parse natural language availability into structured windows."""
    normalized = text.lower()
    windows: list[AvailabilityWindow] = []

    # Try to extract time zone
    time_zone: Optional[str] = None
    tz_match = (
        re.search(r"(?:time\s*zone|tz|timezone)[\s:]*([A-Za-z_/]+)", text, re.IGNORECASE)
        or re.search(
            r"(America/[A-Za-z_]+|Europe/[A-Za-z_]+|Asia/[A-Za-z_]+|Pacific/[A-Za-z_]+|UTC)",
            text,
            re.IGNORECASE,
        )
    )
    if tz_match:
        time_zone = tz_match.group(1)

    # Pattern: "weekdays 9am to 5pm" or "monday 10am-2pm"
    day_time_pattern = re.compile(
        r"(weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday"
        r"|mon|tue|wed|thu|fri|sat|sun|daily|every\s*day)"
        r"(?:\s+(?:and\s+)?(?:weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday"
        r"|saturday|sunday|mon|tue|wed|thu|fri|sat|sun))*"
        r"\s+(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|-)\s*"
        r"(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)",
        re.IGNORECASE,
    )

    for match in day_time_pattern.finditer(normalized):
        day_part = match.group(1)
        start_time = match.group(2)
        end_time = match.group(3)

        days = parse_days(day_part)
        start_minutes = parse_time_to_minutes(start_time)
        end_minutes = parse_time_to_minutes(end_time)

        if days and start_minutes is not None and end_minutes is not None:
            for day in days:
                windows.append(
                    AvailabilityWindow(day=day, start_minutes=start_minutes, end_minutes=end_minutes)
                )

    # Pattern: "weekday mornings" or "monday afternoons"
    day_preset_pattern = re.compile(
        r"(weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday"
        r"|mon|tue|wed|thu|fri|sat|sun|daily|every\s*day)"
        r"\s+(morning|afternoon|evening|business\s*hours?|work\s*hours?)",
        re.IGNORECASE,
    )

    for match in day_preset_pattern.finditer(normalized):
        day_part = match.group(1)
        time_part = match.group(2).lower()

        days = parse_days(day_part)
        time_range = TIME_PRESETS.get(time_part) or TIME_PRESETS.get(
            time_part.rstrip("s")
        )

        if days and time_range:
            for day in days:
                exists = any(
                    w.day == day
                    and w.start_minutes == time_range["start"]
                    and w.end_minutes == time_range["end"]
                    for w in windows
                )
                if not exists:
                    windows.append(
                        AvailabilityWindow(
                            day=day,
                            start_minutes=time_range["start"],
                            end_minutes=time_range["end"],
                        )
                    )

    # Fallback: "I'm free mornings" (assume weekdays)
    if not windows:
        for preset, time_range in TIME_PRESETS.items():
            if preset in normalized:
                weekdays = [DayOfWeek.MON, DayOfWeek.TUE, DayOfWeek.WED, DayOfWeek.THU, DayOfWeek.FRI]
                for day in weekdays:
                    windows.append(
                        AvailabilityWindow(
                            day=day,
                            start_minutes=time_range["start"],
                            end_minutes=time_range["end"],
                        )
                    )
                break

    if not windows:
        return None

    return {"windows": windows, "time_zone": time_zone}


def format_time(minutes: int) -> str:
    """Format minutes-from-midnight as a human-readable time."""
    hours = minutes // 60
    mins = minutes % 60
    period = "pm" if hours >= 12 else "am"
    display_hours = hours - 12 if hours > 12 else (12 if hours == 0 else hours)
    if mins > 0:
        return f"{display_hours}:{mins:02d}{period}"
    return f"{display_hours}{period}"


_DAY_DISPLAY: dict[DayOfWeek, str] = {
    DayOfWeek.MON: "Monday",
    DayOfWeek.TUE: "Tuesday",
    DayOfWeek.WED: "Wednesday",
    DayOfWeek.THU: "Thursday",
    DayOfWeek.FRI: "Friday",
    DayOfWeek.SAT: "Saturday",
    DayOfWeek.SUN: "Sunday",
}


def format_day(day: DayOfWeek) -> str:
    """Format a DayOfWeek for display."""
    return _DAY_DISPLAY.get(day, day.value)


# ============================================================================
# ACTION DEFINITION
# ============================================================================


def _validate_set_availability(runtime: Any, message: Any) -> bool:
    """Validate if this message should trigger the SET_AVAILABILITY action."""
    text = (getattr(getattr(message, "content", None), "text", None) or "").lower()
    return any(
        kw in text
        for kw in (
            "available", "availability", "free on", "i'm free",
            "can meet", "my time", "morning", "afternoon", "evening",
        )
    )


async def _handle_set_availability(
    runtime: Any,
    message: Any,
    state: Any = None,
    options: Optional[dict[str, Any]] = None,
    callback: Any = None,
) -> dict[str, Any]:
    """Handle the SET_AVAILABILITY action."""
    import os

    from ..service import SchedulingService

    scheduling_service: Optional[SchedulingService] = None
    if hasattr(runtime, "get_service"):
        scheduling_service = runtime.get_service("SCHEDULING")

    if not scheduling_service:
        if callback:
            await callback({"text": "Scheduling service is not available. Please try again later."})
        return {"success": False}

    entity_id = getattr(message, "entity_id", None)
    if not entity_id:
        if callback:
            await callback({"text": "I could not identify you. Please try again."})
        return {"success": False}

    text = getattr(getattr(message, "content", None), "text", "") or ""
    parsed = parse_availability_text(text)

    if not parsed or not parsed["windows"]:
        if callback:
            await callback({
                "text": 'I couldn\'t understand your availability. Try: "weekdays 9am-5pm" or "Monday afternoons"'
            })
        return {"success": False}

    default_tz = os.environ.get("DEFAULT_TIMEZONE", "America/New_York")
    availability = await scheduling_service.get_availability(entity_id)

    from ..types import Availability

    if not availability:
        availability = Availability(
            time_zone=parsed["time_zone"] or default_tz,
            weekly=[],
            exceptions=[],
        )

    if parsed["time_zone"]:
        availability.time_zone = parsed["time_zone"]

    for new_window in parsed["windows"]:
        exists = any(
            w.day == new_window.day
            and w.start_minutes == new_window.start_minutes
            and w.end_minutes == new_window.end_minutes
            for w in availability.weekly
        )
        if not exists:
            availability.weekly.append(new_window)

    await scheduling_service.save_availability(entity_id, availability)

    added = ", ".join(
        f"{format_day(w.day)} {format_time(w.start_minutes)}-{format_time(w.end_minutes)}"
        for w in parsed["windows"]
    )

    if callback:
        await callback({
            "text": f"Got it! I've saved your availability: {added}. I'll use this to find meeting times that work for you."
        })

    return {"success": True}


set_availability_action: dict[str, Any] = {
    "name": "SET_AVAILABILITY",
    "similes": [
        "UPDATE_AVAILABILITY",
        "SET_SCHEDULE",
        "UPDATE_SCHEDULE",
        "SET_FREE_TIME",
        "WHEN_FREE",
    ],
    "description": "Set the user's availability for scheduling meetings",
    "validate": _validate_set_availability,
    "handler": _handle_set_availability,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "I'm free weekdays 9am to 5pm"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": (
                        "Got it! I've saved your availability: Monday 9am-5pm, "
                        "Tuesday 9am-5pm, Wednesday 9am-5pm, Thursday 9am-5pm, "
                        "Friday 9am-5pm. I'll use this to find meeting times that work for you."
                    ),
                },
            },
        ],
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Available Monday afternoons and Wednesday mornings"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": (
                        "Got it! I've saved your availability: Monday 12pm-5pm, "
                        "Wednesday 9am-12pm. I'll use this to find meeting times that work for you."
                    ),
                },
            },
        ],
    ],
}
