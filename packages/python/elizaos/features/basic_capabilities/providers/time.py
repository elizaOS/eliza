from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("TIME")


async def get_time_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    _ = runtime, message, state

    now = datetime.now(UTC)
    iso_string = now.isoformat()
    timestamp_ms = int(now.timestamp() * 1000)
    human_readable = now.strftime("%A, %B %d, %Y at %H:%M:%S UTC")

    text = (
        f"The current date and time is {human_readable}. "
        "Please use this as your reference for any time-based operations or responses."
    )

    return ProviderResult(
        text=text,
        values={"time": human_readable},
        data={"timestamp": timestamp_ms, "isoString": iso_string},
    )


time_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_time_context,
    dynamic=_spec.get("dynamic", True),
)
