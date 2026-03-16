"""CLI utilities.

Common utilities for CLI operations including duration parsing,
byte formatting, and string helpers.
"""

from __future__ import annotations

import re

DEFAULT_CLI_NAME: str = "elizaos"
"""Default CLI name."""

DEFAULT_CLI_VERSION: str = "1.0.0"
"""Default CLI version."""

# Regex for matching duration components like "1h", "30m", "500ms".
_DURATION_PART_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*"
    r"(milliseconds?|ms|seconds?|sec|s|minutes?|min|m|hours?|hr|h|days?|d)?",
    re.IGNORECASE,
)

_UNIT_TO_MS: dict[str, float] = {
    "ms": 1,
    "millisecond": 1,
    "milliseconds": 1,
    "s": 1_000,
    "sec": 1_000,
    "second": 1_000,
    "seconds": 1_000,
    "m": 60_000,
    "min": 60_000,
    "minute": 60_000,
    "minutes": 60_000,
    "h": 3_600_000,
    "hr": 3_600_000,
    "hour": 3_600_000,
    "hours": 3_600_000,
    "d": 86_400_000,
    "day": 86_400_000,
    "days": 86_400_000,
}


def parse_duration(s: str) -> int | None:
    """Parse a duration string to milliseconds.

    Supports compound formats and multiple unit suffixes::

        "1h"      -> 3600000
        "30m"     -> 1800000
        "1h30m"   -> 5400000
        "2d"      -> 172800000
        "500ms"   -> 500
        "1000"    -> 1000 (plain number = milliseconds)

    Returns ``None`` for invalid input.
    """
    s = s.strip().lower()
    if not s:
        return None

    # Plain numeric value -> milliseconds.
    try:
        return int(s)
    except ValueError:
        pass

    # Try float as bare number.
    try:
        return round(float(s))
    except ValueError:
        pass

    total_ms = 0
    found_any = False
    pos = 0

    while pos < len(s):
        # Skip whitespace.
        while pos < len(s) and s[pos].isspace():
            pos += 1
        if pos >= len(s):
            break

        match = _DURATION_PART_RE.match(s, pos)
        if not match:
            return None

        value = float(match.group(1))
        unit = (match.group(2) or "").lower()

        if not unit:
            if found_any:
                return None  # Bare number in middle of compound.
            # Bare number = ms.
            multiplier = 1.0
        else:
            multiplier = _UNIT_TO_MS.get(unit)
            if multiplier is None:
                return None

        total_ms += round(value * multiplier)
        found_any = True
        pos = match.end()

    return total_ms if found_any else None


def format_duration(ms: int) -> str:
    """Format milliseconds as a human-readable string.

    Uses the largest appropriate unit:

    - ``< 1s``  -> ``"450ms"``
    - ``< 1m``  -> ``"12.3s"``
    - ``< 1h``  -> ``"5.2m"``
    - ``< 1d``  -> ``"3.5h"``
    - ``>= 1d`` -> ``"2.0d"``
    """
    if ms < 1_000:
        return f"{ms}ms"
    if ms < 60_000:
        return f"{ms / 1_000:.1f}s"
    if ms < 3_600_000:
        return f"{ms / 60_000:.1f}m"
    if ms < 86_400_000:
        return f"{ms / 3_600_000:.1f}h"
    return f"{ms / 86_400_000:.1f}d"


def format_bytes(bytes_count: int) -> str:
    """Format a byte count as a human-readable string (e.g. ``"1.5 MB"``).

    Uses binary prefixes (1 KB = 1024 bytes).
    """
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(bytes_count)
    unit_idx = 0

    while value >= 1024.0 and unit_idx < len(units) - 1:
        value /= 1024.0
        unit_idx += 1

    if unit_idx == 0:
        return f"{bytes_count} B"
    return f"{value:.1f} {units[unit_idx]}"


def truncate_string(s: str, max_len: int) -> str:
    """Truncate a string to at most ``max_len`` characters.

    Appends ``"..."`` if truncated. If the string fits, returns it unchanged.
    """
    if len(s) <= max_len:
        return s
    if max_len <= 3:
        return "." * max_len
    return s[: max_len - 3] + "..."


def parse_timeout_ms(input_str: str | None, default_ms: int) -> int:
    """Parse a timeout string with a fallback default.

    If ``input_str`` is ``None`` or parsing fails, returns ``default_ms``.
    """
    if input_str is None:
        return default_ms
    result = parse_duration(input_str)
    return result if result is not None else default_ms


def format_cli_command(
    command: str,
    cli_name: str | None = None,
    profile: str | None = None,
    env: str | None = None,
) -> str:
    """Format a CLI command string with optional profile and env context."""
    parts = [cli_name or DEFAULT_CLI_NAME]
    if profile is not None:
        parts.append(f"--profile {profile}")
    if env is not None:
        parts.append(f"--env {env}")
    parts.append(command)
    return " ".join(parts)
