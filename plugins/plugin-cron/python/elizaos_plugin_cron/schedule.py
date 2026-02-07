"""Schedule utilities: validation, parsing, next-run computation, formatting."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from croniter import croniter

from elizaos_plugin_cron.types import ScheduleAt, ScheduleCron, ScheduleEvery, ScheduleType


# ---------------------------------------------------------------------------
# Cron expression validation
# ---------------------------------------------------------------------------

def validate_cron_expression(expr: str) -> bool:
    """Validate a standard 5-field cron expression using croniter."""
    trimmed = expr.strip()
    if not trimmed:
        return False
    try:
        croniter(trimmed)
        return True
    except (ValueError, KeyError, TypeError):
        return False


# ---------------------------------------------------------------------------
# Duration parsing
# ---------------------------------------------------------------------------

_DURATION_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$",
    re.IGNORECASE,
)


def parse_duration(text: str) -> timedelta | None:
    """Parse a duration string like '30s', '5m', '2h', '1d' into a timedelta."""
    m = _DURATION_RE.match(text.strip())
    if not m:
        return None

    value = float(m.group(1))
    if value <= 0 or not (value == value):  # reject 0 and NaN
        return None

    unit = m.group(2).lower()
    if unit.startswith("s"):
        seconds = value
    elif unit.startswith("m"):
        seconds = value * 60
    elif unit.startswith("h"):
        seconds = value * 3600
    elif unit.startswith("d"):
        seconds = value * 86400
    else:
        return None

    if seconds <= 0:
        return None
    return timedelta(seconds=seconds)


# ---------------------------------------------------------------------------
# Schedule parsing
# ---------------------------------------------------------------------------

def parse_schedule(text: str) -> ScheduleType:
    """Parse a schedule string into a ScheduleType.

    Accepts:
    - ISO 8601 datetime → ScheduleAt
    - Duration string (e.g. '30s', '5m') → ScheduleEvery
    - 5-field cron expression → ScheduleCron

    Raises ValueError on unparseable input.
    """
    trimmed = text.strip()
    if not trimmed:
        raise ValueError("Empty schedule string")

    # Try ISO 8601
    try:
        dt = datetime.fromisoformat(trimmed.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return ScheduleAt(at=dt)
    except (ValueError, TypeError):
        pass

    # Try duration
    dur = parse_duration(trimmed)
    if dur is not None:
        return ScheduleEvery(interval=dur)

    # Try cron expression
    if validate_cron_expression(trimmed):
        return ScheduleCron(expr=trimmed)

    raise ValueError(f"Cannot parse schedule: {trimmed}")


# ---------------------------------------------------------------------------
# Next-run computation
# ---------------------------------------------------------------------------

def compute_next_run(
    schedule: ScheduleType,
    from_dt: datetime | None = None,
) -> datetime | None:
    """Compute the next run time for a schedule from a given reference point."""
    if from_dt is None:
        from_dt = datetime.now(timezone.utc)

    if isinstance(schedule, ScheduleAt):
        at = schedule.at
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        return at if at > from_dt else None

    if isinstance(schedule, ScheduleEvery):
        total_seconds = schedule.interval.total_seconds()
        if total_seconds <= 0:
            return None
        return from_dt + schedule.interval

    if isinstance(schedule, ScheduleCron):
        try:
            cron = croniter(schedule.expr, from_dt)
            next_dt = cron.get_next(datetime)
            if next_dt.tzinfo is None:
                next_dt = next_dt.replace(tzinfo=timezone.utc)
            return next_dt
        except (ValueError, KeyError, TypeError):
            return None

    return None


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def format_schedule(schedule: ScheduleType) -> str:
    """Format a schedule as a human-readable string."""
    if isinstance(schedule, ScheduleAt):
        return f"once at {schedule.at.strftime('%Y-%m-%d %H:%M:%S UTC')}"

    if isinstance(schedule, ScheduleEvery):
        total_ms = int(schedule.interval.total_seconds() * 1000)
        if total_ms >= 86_400_000:
            days = total_ms // 86_400_000
            return f"every {days} day{'s' if days != 1 else ''}"
        if total_ms >= 3_600_000:
            hours = total_ms // 3_600_000
            return f"every {hours} hour{'s' if hours != 1 else ''}"
        if total_ms >= 60_000:
            minutes = total_ms // 60_000
            return f"every {minutes} minute{'s' if minutes != 1 else ''}"
        seconds = total_ms // 1000
        return f"every {seconds} second{'s' if seconds != 1 else ''}"

    if isinstance(schedule, ScheduleCron):
        return f"cron: {schedule.expr}"

    return "unknown schedule"


# ---------------------------------------------------------------------------
# Natural language parsing
# ---------------------------------------------------------------------------

_EVERY_N_RE = re.compile(
    r"^every\s+(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?)$", re.IGNORECASE
)
_EVERY_SINGLE_RE = re.compile(
    r"^every\s+(second|minute|hour|day|week)$", re.IGNORECASE
)
_DAILY_AT_RE = re.compile(
    r"^daily\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", re.IGNORECASE
)


def parse_natural_language_schedule(text: str) -> ScheduleType | None:
    """Parse simple natural language schedule descriptions.

    Supported:
    - "every 5 minutes", "every 2 hours", "every 30 seconds"
    - "every minute", "every hour", "every day"
    - "daily at 9am", "daily at 14:30"
    - "hourly", "daily", "weekly"
    """
    normalized = text.strip().lower()

    # "every N unit(s)"
    m = _EVERY_N_RE.match(normalized)
    if m:
        value = int(m.group(1))
        unit = m.group(2)[0]  # first char: s/m/h/d/w
        multipliers = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
        seconds = value * multipliers.get(unit, 0)
        if seconds > 0:
            return ScheduleEvery(interval=timedelta(seconds=seconds))

    # "every <unit>" without number
    m = _EVERY_SINGLE_RE.match(normalized)
    if m:
        unit = m.group(1)
        mapping = {
            "second": 1, "minute": 60, "hour": 3600,
            "day": 86400, "week": 604800,
        }
        seconds = mapping.get(unit, 0)
        if seconds > 0:
            return ScheduleEvery(interval=timedelta(seconds=seconds))

    # "daily at HH:MM" or "daily at Ham/Hpm"
    m = _DAILY_AT_RE.match(normalized)
    if m:
        hour = int(m.group(1))
        minute = int(m.group(2)) if m.group(2) else 0
        ampm = m.group(3)
        if ampm:
            if ampm.lower() == "pm" and hour != 12:
                hour += 12
            elif ampm.lower() == "am" and hour == 12:
                hour = 0
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return ScheduleCron(expr=f"{minute} {hour} * * *")

    # Shorthand keywords
    shortcuts: dict[str, str] = {
        "hourly": "0 * * * *",
        "daily": "0 0 * * *",
        "weekly": "0 0 * * 0",
    }
    if normalized in shortcuts:
        return ScheduleCron(expr=shortcuts[normalized])

    return None
