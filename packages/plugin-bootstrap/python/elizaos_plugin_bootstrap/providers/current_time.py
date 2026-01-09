"""
Current Time Provider - Provides current time and date information.

This provider supplies temporal context to the agent, including
current time, date, timezone, and related information.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_current_time_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get the current time context.

    Returns time information including:
    - Current UTC time
    - ISO format timestamp
    - Human-readable date and time
    - Day of week
    """
    now = datetime.now(timezone.utc)

    # Format various time representations
    iso_timestamp = now.isoformat()
    human_readable = now.strftime("%A, %B %d, %Y at %H:%M:%S UTC")
    date_only = now.strftime("%Y-%m-%d")
    time_only = now.strftime("%H:%M:%S")
    day_of_week = now.strftime("%A")
    unix_timestamp = int(now.timestamp())

    context_text = f"""# Current Time
- Date: {date_only}
- Time: {time_only} UTC
- Day: {day_of_week}
- Full: {human_readable}
- ISO: {iso_timestamp}"""

    return ProviderResult(
        text=context_text,
        values={
            "currentTime": iso_timestamp,
            "currentDate": date_only,
            "dayOfWeek": day_of_week,
            "unixTimestamp": unix_timestamp,
        },
        data={
            "iso": iso_timestamp,
            "date": date_only,
            "time": time_only,
            "dayOfWeek": day_of_week,
            "humanReadable": human_readable,
            "unixTimestamp": unix_timestamp,
        },
    )


# Create the provider instance
current_time_provider = Provider(
    name="CURRENT_TIME",
    description="Provides current time and date information in various formats",
    get=get_current_time_context,
    dynamic=True,  # Time changes constantly
)

