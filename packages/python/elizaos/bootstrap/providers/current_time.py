from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("CURRENT_TIME")


async def get_current_time_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    now = datetime.now(UTC)

    iso_timestamp = now.isoformat()
    human_readable = now.strftime("%A, %B %d, %Y at %H:%M:%S UTC")
    date_only = now.strftime("%Y-%m-%d")
    time_only = now.strftime("%H:%M:%S")
    day_of_week = now.strftime("%A")
    unix_timestamp = int(now.timestamp())

    context_text = f"# Current Time\n- Date: {date_only}\n- Time: {time_only} UTC\n- Day: {day_of_week}\n- Full: {human_readable}\n- ISO: {iso_timestamp}"

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


current_time_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_current_time_context,
    dynamic=_spec.get("dynamic", True),
)
